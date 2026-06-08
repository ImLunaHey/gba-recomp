// LZ77 decompression correctness tests, with emphasis on the VRAM-mode
// halfword buffering edge case (back-reference to a byte still sitting
// in the halfword buffer, not yet flushed to VRAM).

import { describe, it, expect } from 'vitest';
import { Bus } from '../memory/bus';
import { Io } from '../io/io';
import { Dma } from '../io/dma';
import { Timers } from '../io/timers';
import { Irq } from '../io/irq';
import { Keypad } from '../io/keypad';
import { Ppu } from '../ppu/ppu';
import { Cpu } from '../cpu/cpu';
import { BiosHle } from '../bios/hle';

function makeEmu() {
  const bus = new Bus();
  const irq = new Irq();
  const keypad = new Keypad();
  const dma = new Dma(bus, irq);
  const timers = new Timers(irq);
  const ppu = new Ppu(bus, irq, dma);
  const cpu = new Cpu(bus);
  const io = new Io(bus, ppu, dma, timers, irq, keypad, cpu);
  bus.attachIo(io);
  bus.attachSave({ read: () => 0xFF, write: () => {} });
  bus.loadRom(new Uint8Array(0x100));
  const bios = new BiosHle(cpu, bus);
  cpu.bios = bios;
  return { cpu, bus, bios };
}

// Build a minimal LZ77 stream that ends up writing `expected` bytes.
// We control the flags + literals + back-refs by hand.
function buildLZ77Header(uncompressedLen: number): number[] {
  // 4-byte header: 0x10, len[0], len[1], len[2]
  return [0x10, uncompressedLen & 0xFF, (uncompressedLen >> 8) & 0xFF, (uncompressedLen >> 16) & 0xFF];
}

// Encode a block of 8 elements where bit i (MSB-first) decides literal (0) vs ref (1).
// `elems` is an array of {kind:'lit', byte} or {kind:'ref', disp, len}.
function encodeBlock(elems: Array<{ kind: 'lit'; byte: number } | { kind: 'ref'; disp: number; len: number }>): number[] {
  const out: number[] = [];
  let flags = 0;
  for (let i = 0; i < elems.length; i++) {
    if (elems[i].kind === 'ref') flags |= 1 << (7 - i);
  }
  out.push(flags);
  for (const e of elems) {
    if (e.kind === 'lit') out.push(e.byte);
    else {
      // 16-bit BE: [(len-3) << 4 | (disp-1) >> 8] [(disp-1) & 0xFF]
      const dispEnc = e.disp - 1;
      const lenEnc = e.len - 3;
      out.push((lenEnc << 4) | ((dispEnc >> 8) & 0xF));
      out.push(dispEnc & 0xFF);
    }
  }
  return out;
}

function runLZ77(toVram: boolean, srcBytes: number[], destAddr: number) {
  const { cpu, bus, bios } = makeEmu();
  // Place compressed source at EWRAM 0x02000000.
  const SRC = 0x02000000;
  for (let i = 0; i < srcBytes.length; i++) bus.write8(SRC + i, srcBytes[i]);
  cpu.state.r[0] = SRC;
  cpu.state.r[1] = destAddr;
  bios.handleSwi(toVram ? 0x12 : 0x11);
  return bus;
}

describe('LZ77 decompression', () => {
  it('decompresses 8 literal bytes', () => {
    const src = [
      ...buildLZ77Header(8),
      ...encodeBlock([
        { kind: 'lit', byte: 0xAA },
        { kind: 'lit', byte: 0xBB },
        { kind: 'lit', byte: 0xCC },
        { kind: 'lit', byte: 0xDD },
        { kind: 'lit', byte: 0xEE },
        { kind: 'lit', byte: 0xFF },
        { kind: 'lit', byte: 0x11 },
        { kind: 'lit', byte: 0x22 },
      ]),
    ];
    const bus = runLZ77(true, src, 0x06000000);  // VRAM dest
    for (let i = 0; i < 8; i++) {
      expect(bus.read8(0x06000000 + i)).toBe([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22][i]);
    }
  });

  it('back-ref with disp=1 from buffer (the bug pattern)', () => {
    // Write byte 0xAB, then back-ref len=3 disp=1 (should produce 0xAB three more times).
    // Total output: 0xAB AB AB AB = 4 bytes.
    const src = [
      ...buildLZ77Header(4),
      ...encodeBlock([
        { kind: 'lit', byte: 0xAB },
        { kind: 'ref', disp: 1, len: 3 },
        { kind: 'lit', byte: 0x00 },  // padding to fill 8 elements
        { kind: 'lit', byte: 0x00 },
        { kind: 'lit', byte: 0x00 },
        { kind: 'lit', byte: 0x00 },
        { kind: 'lit', byte: 0x00 },
        { kind: 'lit', byte: 0x00 },
      ]),
    ];
    const bus = runLZ77(true, src, 0x06001000);
    for (let i = 0; i < 4; i++) {
      expect(`vram[${i}]=${bus.read8(0x06001000 + i).toString(16)}`).toBe(`vram[${i}]=ab`);
    }
  });

  it('back-ref with disp=1 len=8 across multiple halfwords', () => {
    // Write 0xAB, then 8 more 0xAB via back-ref. Total 9 bytes (1 + 8).
    // But we need even-byte length for VRAM mode; do len 7 → 8 total.
    const src = [
      ...buildLZ77Header(8),
      ...encodeBlock([
        { kind: 'lit', byte: 0xAB },
        { kind: 'ref', disp: 1, len: 7 },
        { kind: 'lit', byte: 0 },
        { kind: 'lit', byte: 0 },
        { kind: 'lit', byte: 0 },
        { kind: 'lit', byte: 0 },
        { kind: 'lit', byte: 0 },
        { kind: 'lit', byte: 0 },
      ]),
    ];
    const bus = runLZ77(true, src, 0x06002000);
    for (let i = 0; i < 8; i++) {
      expect(bus.read8(0x06002000 + i)).toBe(0xAB);
    }
  });

  it('mixed literal + disp=2 back-ref', () => {
    // Write 0xAA, 0xBB, then back-ref disp=2 len=4 → reads 0xAA 0xBB 0xAA 0xBB.
    // Total: AA BB AA BB AA BB = 6 bytes.
    const src = [
      ...buildLZ77Header(6),
      ...encodeBlock([
        { kind: 'lit', byte: 0xAA },
        { kind: 'lit', byte: 0xBB },
        { kind: 'ref', disp: 2, len: 4 },
        { kind: 'lit', byte: 0 },
        { kind: 'lit', byte: 0 },
        { kind: 'lit', byte: 0 },
        { kind: 'lit', byte: 0 },
        { kind: 'lit', byte: 0 },
      ]),
    ];
    const bus = runLZ77(true, src, 0x06003000);
    expect(bus.read8(0x06003000)).toBe(0xAA);
    expect(bus.read8(0x06003001)).toBe(0xBB);
    expect(bus.read8(0x06003002)).toBe(0xAA);
    expect(bus.read8(0x06003003)).toBe(0xBB);
    expect(bus.read8(0x06003004)).toBe(0xAA);
    expect(bus.read8(0x06003005)).toBe(0xBB);
  });
});
