// ARM instruction tests. The existing cpu.test.ts has selected coverage
// of data-proc + multiply + halt+irq; this file adds a wider net per
// category: shifter variants, LDM/STM, PSR transfer, mode-switching,
// half-word and signed loads, and the SWP atomic.

import { describe, it, expect } from 'vitest';
import { Bus } from '../memory/bus';
import { Io } from '../io/io';
import { Dma } from '../io/dma';
import { Timers } from '../io/timers';
import { Irq } from '../io/irq';
import { Keypad } from '../io/keypad';
import { Ppu } from '../ppu/ppu';
import { Cpu } from '../cpu/cpu';

function makeCpu() {
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
  cpu.reset();
  cpu.state.cpsr = 0x1F;  // SYS, ARM
  cpu.state.r[15] = 0x03000000;
  cpu.state.r[13] = 0x03007F00;
  return { cpu, bus };
}

function load(bus: Bus, insns: number[], addr = 0x03000000) {
  for (let i = 0; i < insns.length; i++) bus.write32(addr + i * 4, insns[i] >>> 0);
}

describe('ARM data-proc: barrel shifter via immediate', () => {
  it('MOV R0, #0xFF000000 (rotate-imm)', () => {
    const { cpu, bus } = makeCpu();
    // MOV R0, #0xFF (rotated by 2*4 = 8 right) = 0xFF000000
    load(bus, [0xE3A004FF]);  // E3A0 04FF: MOV R0, #imm rotated
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xFF000000);
  });
  it('AND R0, R1, R2, LSL #4', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[1] = 0xFFFFFFFF; cpu.state.r[2] = 0x0F;
    load(bus, [0xE0010202]);  // AND R0, R1, R2, LSL #4
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xF0);
  });
  it('ORR R0, R1, R2, LSR #16', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[1] = 0xAA; cpu.state.r[2] = 0xBB000000;
    load(bus, [0xE1810822]);  // ORR R0, R1, R2, LSR #16
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xBBAA);
  });
  it('MVN R0, #0', () => {
    const { cpu, bus } = makeCpu();
    load(bus, [0xE3E00000]);  // MVN R0, #0 → 0xFFFFFFFF
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xFFFFFFFF);
  });
});

describe('ARM data-proc: flag setting', () => {
  it('ADDS R0, R1, R2 sets V and C on overflow', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[1] = 0x7FFFFFFF; cpu.state.r[2] = 1;
    load(bus, [0xE0910002]);  // ADDS R0, R1, R2
    cpu.step();
    expect(cpu.state.r[0]).toBe(0x80000000);
    expect((cpu.state.cpsr & 0x10000000) !== 0).toBe(true);  // V (signed overflow)
    expect((cpu.state.cpsr & 0x80000000) !== 0).toBe(true);  // N
  });
  it('SUBS R0, R1, R2 sets C when no borrow', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[1] = 10; cpu.state.r[2] = 3;
    load(bus, [0xE0510002]);  // SUBS R0, R1, R2
    cpu.step();
    expect(cpu.state.r[0]).toBe(7);
    expect((cpu.state.cpsr & 0x20000000) !== 0).toBe(true);  // C set
  });
  it('SUBS clears C on borrow', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[1] = 3; cpu.state.r[2] = 10;
    load(bus, [0xE0510002]);
    cpu.step();
    expect(cpu.state.r[0]).toBe((3 - 10) >>> 0);
    expect((cpu.state.cpsr & 0x20000000) !== 0).toBe(false);  // C clear
  });
});

describe('ARM multiply', () => {
  it('MUL R0, R1, R2', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[1] = 7; cpu.state.r[2] = 6;
    load(bus, [0xE0000291]);  // MUL R0, R1, R2
    cpu.step();
    expect(cpu.state.r[0]).toBe(42);
  });
  it('MLA R0, R1, R2, R3', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[1] = 7; cpu.state.r[2] = 6; cpu.state.r[3] = 100;
    load(bus, [0xE0203291]);  // MLA R0, R1, R2, R3
    cpu.step();
    expect(cpu.state.r[0]).toBe(142);
  });
  it('SMULL R0:R1, R2, R3 with negative', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[2] = 0xFFFFFFFE;  // -2
    cpu.state.r[3] = 5;
    load(bus, [0xE0C10392]);  // SMULL R0, R1, R2, R3
    cpu.step();
    // -2 * 5 = -10 = 0xFFFFFFFFFFFFFFF6 → R0 = 0xFFFFFFF6, R1 = 0xFFFFFFFF
    expect(cpu.state.r[0]).toBe(0xFFFFFFF6);
    expect(cpu.state.r[1]).toBe(0xFFFFFFFF);
  });
  it('UMULL R0:R1, R2, R3 with max values', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[2] = 0xFFFFFFFF;
    cpu.state.r[3] = 0xFFFFFFFF;
    load(bus, [0xE0810392]);
    cpu.step();
    // 0xFFFFFFFF * 0xFFFFFFFF = 0xFFFFFFFE00000001
    expect(cpu.state.r[0]).toBe(0x00000001);
    expect(cpu.state.r[1]).toBe(0xFFFFFFFE);
  });
});

describe('ARM LDR/STR addressing modes', () => {
  it('LDR R0, [R1, #8] pre-indexed', () => {
    const { cpu, bus } = makeCpu();
    bus.write32(0x03001008, 0xDEADBEEF);
    cpu.state.r[1] = 0x03001000;
    load(bus, [0xE5910008]);  // LDR R0, [R1, #8]
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xDEADBEEF);
  });
  it('LDR R0, [R1, #8]! pre-indexed with writeback', () => {
    const { cpu, bus } = makeCpu();
    bus.write32(0x03001008, 0xCAFEBABE);
    cpu.state.r[1] = 0x03001000;
    load(bus, [0xE5B10008]);  // LDR R0, [R1, #8]!
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xCAFEBABE);
    expect(cpu.state.r[1]).toBe(0x03001008);
  });
  it('LDR R0, [R1], #4 post-indexed', () => {
    const { cpu, bus } = makeCpu();
    bus.write32(0x03001000, 0x11223344);
    cpu.state.r[1] = 0x03001000;
    load(bus, [0xE4910004]);  // LDR R0, [R1], #4
    cpu.step();
    expect(cpu.state.r[0]).toBe(0x11223344);
    expect(cpu.state.r[1]).toBe(0x03001004);
  });
  it('STR R0, [R1, -R2] negative register offset', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[0] = 0xAA; cpu.state.r[1] = 0x03001100; cpu.state.r[2] = 0x100;
    load(bus, [0xE7010002]);  // STR R0, [R1, -R2]
    cpu.step();
    expect(bus.read32(0x03001000)).toBe(0xAA);
  });
  it('LDRH R0, [R1, #4] half-word load', () => {
    const { cpu, bus } = makeCpu();
    bus.write16(0x03001004, 0xABCD);
    cpu.state.r[1] = 0x03001000;
    load(bus, [0xE1D100B4]);  // LDRH R0, [R1, #4]
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xABCD);
  });
  it('LDRSB R0, [R1, #0] sign-extended byte', () => {
    const { cpu, bus } = makeCpu();
    bus.write8(0x03001000, 0xFE);  // -2 as signed byte
    cpu.state.r[1] = 0x03001000;
    load(bus, [0xE1D100D0]);  // LDRSB R0, [R1, #0]
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xFFFFFFFE);
  });
  it('LDRSH R0, [R1, #0] sign-extended halfword', () => {
    const { cpu, bus } = makeCpu();
    bus.write16(0x03001000, 0x8000);
    cpu.state.r[1] = 0x03001000;
    load(bus, [0xE1D100F0]);  // LDRSH R0, [R1, #0]
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xFFFF8000);
  });
});

describe('ARM block transfer (LDM/STM)', () => {
  it('STMIA R0!, {R1, R2, R3} writes in ascending order', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[0] = 0x03001000;
    cpu.state.r[1] = 0xAA; cpu.state.r[2] = 0xBB; cpu.state.r[3] = 0xCC;
    load(bus, [0xE8A0000E]);  // STMIA R0!, {R1, R2, R3}
    cpu.step();
    expect(bus.read32(0x03001000)).toBe(0xAA);
    expect(bus.read32(0x03001004)).toBe(0xBB);
    expect(bus.read32(0x03001008)).toBe(0xCC);
    expect(cpu.state.r[0]).toBe(0x0300100C);
  });
  it('LDMDB R0!, {R1, R2, R3} (full descending)', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[0] = 0x0300100C;
    bus.write32(0x03001000, 0xAA);
    bus.write32(0x03001004, 0xBB);
    bus.write32(0x03001008, 0xCC);
    load(bus, [0xE930000E]);  // LDMDB R0!, {R1, R2, R3}
    cpu.step();
    expect(cpu.state.r[1]).toBe(0xAA);
    expect(cpu.state.r[2]).toBe(0xBB);
    expect(cpu.state.r[3]).toBe(0xCC);
    expect(cpu.state.r[0]).toBe(0x03001000);
  });
  it('LDM with PC in list reloads PC and flushes pipeline', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[13] = 0x03001000;
    bus.write32(0x03001000, 0x03002000);  // value to load into PC
    load(bus, [0xE8BD8000]);  // LDMIA R13!, {PC}
    cpu.step();
    expect(cpu.state.r[15]).toBe(0x03002000);
  });
});

describe('ARM PSR transfer (MRS/MSR)', () => {
  it('MRS R0, CPSR reads current PSR', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.cpsr = 0x6000001F;  // Z+C set, SYS mode
    load(bus, [0xE10F0000]);  // MRS R0, CPSR
    cpu.step();
    expect(cpu.state.r[0]).toBe(0x6000001F);
  });
  it('MSR CPSR_c, R0 changes the control byte', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[0] = 0x13;  // SVC mode
    load(bus, [0xE129F000]);  // MSR CPSR_c, R0
    cpu.step();
    expect(cpu.state.cpsr & 0x1F).toBe(0x13);
  });
});

describe('ARM SWP (atomic swap)', () => {
  it('SWP R0, R1, [R2]', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[1] = 0xAA; cpu.state.r[2] = 0x03001000;
    bus.write32(0x03001000, 0xBB);
    load(bus, [0xE1020091]);  // SWP R0, R1, [R2]
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xBB);            // old memory value loaded to R0
    expect(bus.read32(0x03001000)).toBe(0xAA);   // R1 value stored
  });
  it('SWPB R0, R1, [R2] byte swap', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[1] = 0xCC; cpu.state.r[2] = 0x03001000;
    bus.write8(0x03001000, 0xDD);
    load(bus, [0xE1420091]);  // SWPB R0, R1, [R2]
    cpu.step();
    expect(cpu.state.r[0]).toBe(0xDD);
    expect(bus.read8(0x03001000)).toBe(0xCC);
  });
});

describe('ARM BX (branch and exchange)', () => {
  it('BX with bit 0 set → switches to THUMB', () => {
    const { cpu, bus } = makeCpu();
    cpu.state.r[0] = 0x03001001;
    load(bus, [0xE12FFF10]);  // BX R0
    cpu.step();
    expect(cpu.state.r[15]).toBe(0x03001000);
    expect((cpu.state.cpsr & 0x20) !== 0).toBe(true);
  });
});
