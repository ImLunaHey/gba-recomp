// Serial-IO module: register read/write surface, transfer state machine,
// IRQ raise, and loopback default. Phase A only — no WebRTC transport.

import { describe, it, expect } from 'vitest';
import { Emulator } from '../emulator';
import { Sio, LocalLoopback, type LinkTransport, type MultiplayResult } from '../io/sio';
import { Irq, IRQ_SIO } from '../io/irq';

describe('Sio register surface', () => {
  it('SIOCNT, SIOMLT_SEND, RCNT round-trip via 16-bit MMIO', () => {
    const emu = new Emulator();
    emu.loadRom(new Uint8Array(0x100));
    // SIOCNT — write something that's purely software-controlled (mode +
    // baud + IRQ enable, no START). Bits 2-5 are read-only status, so
    // we exclude them from the round-trip check.
    emu.io.write16(0x4000128, 0x6003);
    expect(emu.io.read16(0x4000128) & 0xFFC3).toBe(0x6003 & 0xFFC3);
    // SIOMLT_SEND — fully software.
    emu.io.write16(0x400012A, 0xBEEF);
    expect(emu.io.read16(0x400012A)).toBe(0xBEEF);
    // RCNT — same.
    emu.io.write16(0x4000134, 0xC000);
    expect(emu.io.read16(0x4000134)).toBe(0xC000);
  });

  it('SIOCNT.SD reflects transport.isConnected()', () => {
    const emu = new Emulator();
    emu.loadRom(new Uint8Array(0x100));
    // Default loopback says "not connected" → SD (bit 3) is low.
    expect(emu.io.read16(0x4000128) & 0x08).toBe(0);
    emu.io.sio.transport = { ...new LocalLoopback(), isConnected: () => true };
    expect(emu.io.read16(0x4000128) & 0x08).toBe(0x08);
  });
});

describe('Multi-play transfer', () => {
  it('completes after ~one scanline and clears START', () => {
    const emu = new Emulator();
    emu.loadRom(new Uint8Array(0x100));
    // Multi-play mode (SIOCNT[13:12]=10), IRQ disabled, START high.
    emu.io.write16(0x400012A, 0x1234);     // our outgoing word
    emu.io.write16(0x4000128, 0x2080);     // mode=multi, START=1
    expect(emu.io.read16(0x4000128) & 0x80).toBe(0x80);
    // Step a few hundred cycles — under the transfer latency, START
    // should still be high.
    emu.io.sio.step(500);
    expect(emu.io.read16(0x4000128) & 0x80).toBe(0x80);
    // After the full latency, START is cleared and the multi slots
    // have our outgoing in slot 0, 0xFFFF elsewhere (loopback).
    emu.io.sio.step(600);
    expect(emu.io.read16(0x4000128) & 0x80).toBe(0);
    expect(emu.io.read16(0x4000120)).toBe(0x1234);
    expect(emu.io.read16(0x4000122)).toBe(0xFFFF);
    expect(emu.io.read16(0x4000124)).toBe(0xFFFF);
    expect(emu.io.read16(0x4000126)).toBe(0xFFFF);
  });

  it('raises SIO IRQ on completion when SIOCNT.IRQ is set', () => {
    const irq = new Irq();
    const sio = new Sio(irq);
    sio.write16(0x12A, 0xABCD);
    sio.write16(0x128, 0x6080);            // mode=multi, IRQ=1, START=1
    sio.step(1100);
    expect(irq.iflag & IRQ_SIO).toBe(IRQ_SIO);
  });

  it('uses transport.multiplayExchange for slot data', () => {
    const irq = new Irq();
    const sio = new Sio(irq);
    let seen = -1;
    const t: LinkTransport = {
      isConnected: () => true,
      multiplayExchange: (local): MultiplayResult => {
        seen = local;
        return { d0: local & 0xFFFF, d1: 0xAAAA, d2: 0xBBBB, d3: 0xCCCC, error: false };
      },
      normal32Exchange: () => 0,
      normal8Exchange: () => 0,
    };
    sio.transport = t;
    sio.write16(0x12A, 0x4242);
    sio.write16(0x128, 0x2080);
    sio.step(1100);
    expect(seen).toBe(0x4242);
    expect(sio.read16(0x120)).toBe(0x4242);
    expect(sio.read16(0x122)).toBe(0xAAAA);
    expect(sio.read16(0x124)).toBe(0xBBBB);
    expect(sio.read16(0x126)).toBe(0xCCCC);
  });
});

describe('Normal-32 transfer', () => {
  it('swaps SIODATA32 with the transport result on completion', () => {
    const irq = new Irq();
    const sio = new Sio(irq);
    sio.transport = {
      isConnected: () => true,
      multiplayExchange: () => ({ d0: 0, d1: 0, d2: 0, d3: 0, error: false }),
      normal32Exchange: (local) => (~local) >>> 0,
      normal8Exchange: () => 0,
    };
    // SIODATA32 = 0xDEAD_BEEF, mode=normal-32 (bit 12 = 1, bits 13 = 0),
    // START=1.
    sio.write16(0x120, 0xBEEF);
    sio.write16(0x122, 0xDEAD);
    sio.write16(0x128, 0x1080);
    sio.step(1100);
    const lo = sio.read16(0x120);
    const hi = sio.read16(0x122);
    expect(((hi << 16) | lo) >>> 0).toBe((~0xDEADBEEF) >>> 0);
  });
});
