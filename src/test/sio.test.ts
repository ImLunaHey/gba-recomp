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
    // Wrap LocalLoopback so we override only isConnected; spreading
    // an instance drops prototype methods (isMaster, etc.) so we keep
    // the original around instead.
    const base = new LocalLoopback();
    emu.io.sio.transport = {
      isConnected: () => true,
      isMaster: () => base.isMaster(),
      multiplayExchange: (v) => base.multiplayExchange(v),
      normal32Exchange: (v) => base.normal32Exchange(v),
      normal8Exchange: (v) => base.normal8Exchange(v),
    };
    expect(emu.io.read16(0x4000128) & 0x08).toBe(0x08);
  });
});

// Multi-play at 115200 baud is the fastest mode and needs ~12k cycles
// to complete. Tests use that baud (SIOCNT[1:0] = 3) to keep step
// counts small. Adding START gives 0x83 (baud=3, START=1).
const MULTI_FAST = 0x2083;       // mode=multi, baud=115200, START=1
const MULTI_FAST_IRQ = 0x6083;   // same + IRQ enable

describe('Multi-play transfer', () => {
  it('completes after the full transfer latency and clears START', () => {
    const emu = new Emulator();
    emu.loadRom(new Uint8Array(0x100));
    emu.io.write16(0x400012A, 0x1234);     // our outgoing word
    emu.io.write16(0x4000128, MULTI_FAST);  // baud 3, ~9500 cycles
    expect(emu.io.read16(0x4000128) & 0x80).toBe(0x80);
    // Mid-transfer — START still high (5000 < 9500 cycle target).
    emu.io.sio.step(5000);
    expect(emu.io.read16(0x4000128) & 0x80).toBe(0x80);
    // Past the latency — START cleared, slot 0 = our word, others
    // = 0xFFFF (loopback "no partner"). Master Sio also resets
    // SIOMULTI to 0xFFFF at transfer start now; before complete()
    // populates slot 0 it would have shown 0xFFFF too.
    emu.io.sio.step(10000);
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
    sio.write16(0x128, MULTI_FAST_IRQ);
    sio.step(280000);
    expect(irq.iflag & IRQ_SIO).toBe(IRQ_SIO);
  });

  it('uses transport.multiplayExchange for slot data', () => {
    const irq = new Irq();
    const sio = new Sio(irq);
    let seen = -1;
    const t: LinkTransport = {
      isConnected: () => true,
      isMaster: () => true,
      multiplayExchange: (local): MultiplayResult => {
        seen = local;
        return { d0: local & 0xFFFF, d1: 0xAAAA, d2: 0xBBBB, d3: 0xCCCC, error: false };
      },
      normal32Exchange: () => 0,
      normal8Exchange: () => 0,
    };
    sio.transport = t;
    sio.write16(0x12A, 0x4242);
    sio.write16(0x128, MULTI_FAST);
    sio.step(280000);
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
      isMaster: () => true,
      multiplayExchange: () => ({ d0: 0, d1: 0, d2: 0, d3: 0, error: false }),
      normal32Exchange: (local) => (~local) >>> 0,
      normal8Exchange: () => 0,
    };
    // SIODATA32 = 0xDEAD_BEEF, mode=normal-32 (bit 12 = 1, bit 13 = 0),
    // bit 1 = 1 → fast 2 MHz clock (~256 cycles), START=1.
    sio.write16(0x120, 0xBEEF);
    sio.write16(0x122, 0xDEAD);
    sio.write16(0x128, 0x1082);
    sio.step(300);
    const lo = sio.read16(0x120);
    const hi = sio.read16(0x122);
    expect(((hi << 16) | lo) >>> 0).toBe((~0xDEADBEEF) >>> 0);
  });
});
