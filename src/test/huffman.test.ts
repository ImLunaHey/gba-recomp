// HuffUnComp (SWI 0x13) correctness tests. Compressed streams are built
// by hand: header word, tree table, then the MSB-first 32-bit bitstream.

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

// 4-byte header: type/dataSize byte, then 24-bit decompressed length.
function buildHuffHeader(dataSize: number, decompressedLen: number, type = 2): number[] {
  return [
    (type << 4) | dataSize,
    decompressedLen & 0xFF,
    (decompressedLen >> 8) & 0xFF,
    (decompressedLen >> 16) & 0xFF,
  ];
}

// Pack a bit string (e.g. '0101...') into big-endian-bit 32-bit words,
// emitted as little-endian bytes (the way they sit in memory for read32).
function packBits(bits: string): number[] {
  const out: number[] = [];
  for (let w = 0; w < bits.length; w += 32) {
    let word = 0;
    for (let b = 0; b < 32; b++) {
      const bit = w + b < bits.length && bits[w + b] === '1' ? 1 : 0;
      word = (word << 1) | bit;
    }
    word >>>= 0;
    out.push(word & 0xFF, (word >> 8) & 0xFF, (word >> 16) & 0xFF, (word >>> 24) & 0xFF);
  }
  return out;
}

function runHuff(srcBytes: number[], destAddr: number) {
  const { cpu, bus, bios } = makeEmu();
  const SRC = 0x02000000;
  for (let i = 0; i < srcBytes.length; i++) bus.write8(SRC + i, srcBytes[i]);
  cpu.state.r[0] = SRC;
  cpu.state.r[1] = destAddr;
  bios.handleSwi(0x13);
  return bus;
}

describe('Huffman decompression (SWI 0x13)', () => {
  it('decodes 8-bit symbols from a 2-symbol tree across two words', () => {
    // Tree: root has both children as data. treeSize=1 → tree is 4 bytes
    // (size byte, root, leaf0, leaf1); bitstream starts at src+8.
    // Codes: A(0x11)='0', B(0x22)='1'.
    // Sequence: A B A B  B A A B  → 8 bytes = 2 output words.
    const src = [
      ...buildHuffHeader(8, 8),
      1, 0xC0, 0x11, 0x22,
      ...packBits('01011001'),
    ];
    const bus = runHuff(src, 0x02010000);
    expect(bus.read32(0x02010000) >>> 0).toBe(0x22112211); // A B A B, LSB first
    expect(bus.read32(0x02010004) >>> 0).toBe(0x22111122); // B A A B
  });

  it('decodes 8-bit symbols from a deeper 3-symbol tree', () => {
    // Tree: root: node0 = leaf A, node1 = inner N; N: node0 = leaf B,
    // node1 = leaf C. Codes: A='0', B='10', C='11'.
    // Layout (offset 0 everywhere): [size, root(0x80), A, N(0xC0), B, C]
    // plus 2 pad bytes so the bitstream stays word-aligned (treeSize=3).
    // Sequence: A B C A  C B A A → bits 0 10 11 0 11 10 0 0.
    const A = 0x41, B = 0x42, C = 0x43;
    const src = [
      ...buildHuffHeader(8, 8),
      3, 0x80, A, 0xC0, B, C, 0x00, 0x00,
      ...packBits('010110111000'),
    ];
    const bus = runHuff(src, 0x02011000);
    const w0 = (A | (B << 8) | (C << 16) | (A << 24)) >>> 0;
    const w1 = (C | (B << 8) | (A << 16) | (A << 24)) >>> 0;
    expect(bus.read32(0x02011000) >>> 0).toBe(w0);
    expect(bus.read32(0x02011004) >>> 0).toBe(w1);
  });

  it('decodes 4-bit symbols packed LSB-nibble first', () => {
    // 2-symbol tree, 4-bit data: codes 3='0', 5='1'.
    // 16 symbols = 8 bytes = 2 output words.
    // Bits: 01100011 10101010 → 3,5,5,3,3,3,5,5  5,3,5,3,5,3,5,3.
    const src = [
      ...buildHuffHeader(4, 8),
      1, 0xC0, 0x03, 0x05,
      ...packBits('0110001110101010'),
    ];
    const bus = runHuff(src, 0x02012000);
    expect(bus.read32(0x02012000) >>> 0).toBe(0x55333553);
    expect(bus.read32(0x02012004) >>> 0).toBe(0x35353535);
  });

  it('masks leaf bytes to the data size', () => {
    // 4-bit data but leaf bytes carry high garbage bits; only the low
    // nibble may reach the output.
    const src = [
      ...buildHuffHeader(4, 4),
      1, 0xC0, 0xF3, 0xA5,
      ...packBits('01010101'),
    ];
    const bus = runHuff(src, 0x02013000);
    expect(bus.read32(0x02013000) >>> 0).toBe(0x53535353);
  });

  it('does not write anything for a non-Huffman type nibble', () => {
    const DEST = 0x02014000;
    const { cpu, bus, bios } = makeEmu();
    for (let i = 0; i < 16; i++) bus.write8(DEST + i, 0xEE); // sentinel
    const src = [
      ...buildHuffHeader(8, 8, 1), // type 1, not Huffman
      1, 0xC0, 0x11, 0x22,
      ...packBits('01011001'),
    ];
    const SRC = 0x02000000;
    for (let i = 0; i < src.length; i++) bus.write8(SRC + i, src[i]);
    cpu.state.r[0] = SRC;
    cpu.state.r[1] = DEST;
    bios.handleSwi(0x13);
    for (let i = 0; i < 16; i++) expect(bus.read8(DEST + i)).toBe(0xEE);
  });
});
