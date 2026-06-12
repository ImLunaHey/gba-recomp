// Recompiler smoke test. Loads a known THUMB instruction sequence into
// IWRAM, enables the JIT, forces compile (no profile threshold), then
// runs the block and checks that the CPU state matches what the
// interpreter would have produced.

import { describe, it, expect } from 'vitest';
import { Emulator } from '../emulator';

function placeInsns(emu: Emulator, addr: number, insns: number[]) {
  for (let i = 0; i < insns.length; i++) {
    emu.bus.write16(addr + i * 2, insns[i] & 0xFFFF);
  }
}

function initThumb(emu: Emulator, startPc: number) {
  emu.cpu.state.cpsr = 0x1F | 0x20;          // SYS mode + THUMB
  emu.cpu.state.r[15] = startPc | 1;           // THUMB low bit
  emu.cpu.state.r[13] = 0x03007F00;            // SP
}

describe('Recompiler (JIT)', () => {
  it('compiles Format 3 MOV/ADD/SUB sequence and matches interpreter', () => {
    const interpResult = (() => {
      const emu = new Emulator();
      emu.loadRom(new Uint8Array(0x100));
      const pc = 0x03002000;
      // MOV R0, #10 ; ADD R0, #5 ; SUB R0, #3
      placeInsns(emu, pc, [0x200A, 0x3005, 0x3803]);
      initThumb(emu, pc);
      for (let i = 0; i < 3; i++) emu.cpu.step();
      return emu.cpu.state.r[0];
    })();
    expect(interpResult).toBe(12);

    // Now do the same through the recompiler.
    const emu = new Emulator();
    emu.loadRom(new Uint8Array(0x100));
    emu.recomp.enabled = true;
    const pc = 0x03002000;
    placeInsns(emu, pc, [0x200A, 0x3005, 0x3803]);
    initThumb(emu, pc);
    // Force-compile by inserting a fake hit count past threshold.
    (emu.recomp as any).hits.set(pc, 1000);
    // tryDispatch returns the number of insns it executed (3 here).
    const ran = emu.recomp.tryDispatch();
    expect(ran).toBe(3);
    expect(emu.cpu.state.r[0]).toBe(12);
    // After the block, r[15] should be advanced past the 3 insns.
    expect(emu.cpu.state.r[15] & ~1).toBe(pc + 6);
  });

  it('compiles a conditional branch and lands on the taken edge', () => {
    const emu = new Emulator();
    emu.loadRom(new Uint8Array(0x100));
    emu.recomp.enabled = true;
    const pc = 0x03002000;
    // MOV R0, #5 ; CMP R0, #5 ; BEQ +4 (skip the next NOP-ish insn)
    placeInsns(emu, pc, [0x2005, 0x2805, 0xD000 /* BEQ #0 -> taken=pc+4+0=pc+4 */]);
    initThumb(emu, pc);
    (emu.recomp as any).hits.set(pc, 1000);
    expect(emu.recomp.tryDispatch()).toBeGreaterThan(0);
    // taken target is pc + 4 + (0 << 1) = pc + 4 (= the next-next insn)
    // But our BEQ encoding with off=0 actually means target = pc + 4 +
    // (0 << 1) = pc + 4 RELATIVE to the branch PC (which is pc + 4 in the
    // sequence). So: target = (pc + 4) + 4 + 0 = pc + 8.
    // The block hits the branch as insn 3 (pc index 4), at decode
    // address pc + 4. Resolved: pc + 4 + 4 = pc + 8.
    expect(emu.cpu.state.r[15] & ~1).toBe(pc + 8);
  });

  it('compiles a Format 9 LDR/STR pair', () => {
    const emu = new Emulator();
    emu.loadRom(new Uint8Array(0x100));
    emu.recomp.enabled = true;
    const pc = 0x03002000;
    // STR R0, [R1, #0]  (encoding: 0110_0_00000_001_000 = 0x6008)
    // LDR R2, [R1, #0]  (encoding: 0110_1_00000_001_010 = 0x680A)
    placeInsns(emu, pc, [0x6008, 0x680A]);
    initThumb(emu, pc);
    emu.cpu.state.r[0] = 0xCAFEBABE;
    emu.cpu.state.r[1] = 0x03004000;
    (emu.recomp as any).hits.set(pc, 1000);
    expect(emu.recomp.tryDispatch()).toBeGreaterThan(0);
    expect(emu.cpu.state.r[2]).toBe(0xCAFEBABE);
  });

  it('rotates unaligned word LDR like the interpreter (misalignment 1/2/3)', () => {
    const base = 0x03004000;
    for (const mis of [1, 2, 3]) {
      // Ground truth: same sequence through the interpreter only.
      const ref = new Emulator();
      ref.loadRom(new Uint8Array(0x100));
      const pc = 0x03002000;
      // LDR R0, [R1, #0]  (encoding: 0110_1_00000_001_000 = 0x6808)
      placeInsns(ref, pc, [0x6808]);
      initThumb(ref, pc);
      ref.bus.write32(base, 0x11223344);
      ref.cpu.state.r[1] = base + mis;
      ref.cpu.step();

      // Same thing through the recompiler.
      const emu = new Emulator();
      emu.loadRom(new Uint8Array(0x100));
      emu.recomp.enabled = true;
      placeInsns(emu, pc, [0x6808]);
      initThumb(emu, pc);
      emu.bus.write32(base, 0x11223344);
      emu.cpu.state.r[1] = base + mis;
      (emu.recomp as any).hits.set(pc, 1000);
      expect(emu.recomp.tryDispatch()).toBe(1);

      for (let i = 0; i < 16; i++) {
        expect(emu.cpu.state.r[i] >>> 0).toBe(ref.cpu.state.r[i] >>> 0);
      }
      expect(emu.cpu.state.cpsr >>> 0).toBe(ref.cpu.state.cpsr >>> 0);
    }
  });

  it('masks unaligned word STR to the aligned word like the interpreter', () => {
    const base = 0x03004000;
    const pc = 0x03002000;
    // Ground truth: interpreter only.
    const ref = new Emulator();
    ref.loadRom(new Uint8Array(0x100));
    // STR R0, [R1, #0]  (encoding: 0110_0_00000_001_000 = 0x6008)
    placeInsns(ref, pc, [0x6008]);
    initThumb(ref, pc);
    ref.cpu.state.r[0] = 0xDEADBEEF;
    ref.cpu.state.r[1] = base + 2;               // misaligned by 2
    ref.cpu.step();
    expect(ref.bus.read32(base) >>> 0).toBe(0xDEADBEEF);

    // Same thing through the recompiler.
    const emu = new Emulator();
    emu.loadRom(new Uint8Array(0x100));
    emu.recomp.enabled = true;
    placeInsns(emu, pc, [0x6008]);
    initThumb(emu, pc);
    emu.cpu.state.r[0] = 0xDEADBEEF;
    emu.cpu.state.r[1] = base + 2;
    (emu.recomp as any).hits.set(pc, 1000);
    expect(emu.recomp.tryDispatch()).toBe(1);
    // The write must land at the aligned word, not base+2 / base+4.
    expect(emu.bus.read32(base) >>> 0).toBe(0xDEADBEEF);
    expect(emu.bus.read32(base + 4) >>> 0).toBe(ref.bus.read32(base + 4) >>> 0);
    for (let i = 0; i < 16; i++) {
      expect(emu.cpu.state.r[i] >>> 0).toBe(ref.cpu.state.r[i] >>> 0);
    }
    expect(emu.cpu.state.cpsr >>> 0).toBe(ref.cpu.state.cpsr >>> 0);
  });

  it('bails out and returns false on unsupported instruction at start', () => {
    const emu = new Emulator();
    emu.loadRom(new Uint8Array(0x100));
    emu.recomp.enabled = true;
    const pc = 0x03002000;
    // PUSH {R0, LR} — Format 14, not supported in this build
    placeInsns(emu, pc, [0xB501]);
    initThumb(emu, pc);
    (emu.recomp as any).hits.set(pc, 1000);
    expect(emu.recomp.tryDispatch()).toBe(0);
    // Now-cached as null so a second call doesn't bother re-trying.
    expect(emu.recomp.tryDispatch()).toBe(0);
  });
});
