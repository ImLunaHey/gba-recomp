import { Bus } from '../memory/bus';
import { CpuState, FLAG_F, FLAG_I, FLAG_T, Mode } from './state';
import { armExecute } from './arm';
import { thumbExecute } from './thumb';
import type { BiosHle } from '../bios/hle';

// Cpu groups state, bus, pipeline tracking, exception vectors, and the
// per-step dispatch. The recompiler will plug in as an alternative path.

export class Cpu {
  state = new CpuState();
  bus: Bus;
  cycles = 0;
  // Pending IRQ line — IO sets this; CPU samples it between instructions.
  irqLine = false;
  bios: BiosHle | null = null;
  // Optional hot path: recompiler reads this to know where to dispatch.
  // Pipeline tracking — for THUMB we fetch the next halfword to be executed.
  // For ARM the next word. r[15] always carries the architectural PC = decoded+8/+4.
  // We keep a `nextOpcode` that we already fetched (the prefetch slot).
  // After a branch we flush and refetch.
  private prefetched = 0;
  private prefetchedValid = false;

  constructor(bus: Bus) { this.bus = bus; }

  reset(): void {
    this.state = new CpuState();
    // Reset vector → r[15] = 0x00000000 (BIOS). With no BIOS we jump to ROM.
    this.state.cpsr = Mode.SVC | FLAG_F | FLAG_I;
    // GBA cartridge boot bypass: when we don't have a real BIOS the ROM
    // entry point is at 0x08000000 and CPU is in System mode.
    this.state.switchMode(Mode.SYS);
    this.state.r[13] = 0x03007F00;       // user/sys SP
    // Set up banked SPs for IRQ and Supervisor that BIOS would normally set.
    this.state.bank_r13[2] = 0x03007FA0; // IRQ
    this.state.bank_r13[3] = 0x03007FE0; // SVC
    this.state.r[15] = 0x08000000;
    this.prefetchedValid = false;
  }

  flushPipeline(): void {
    this.prefetchedValid = false;
  }

  // Single dispatch: fetch, advance PC, execute. Returns cycles consumed.
  step(): number {
    const s = this.state;
    if (s.halted) {
      // Halted — burn a cycle until IRQ wakes us.
      if (this.irqLine && !(s.cpsr & FLAG_I)) s.halted = false;
      this.cycles += 1;
      return 1;
    }

    // Service IRQ between instructions.
    if (this.irqLine && !(s.cpsr & FLAG_I)) {
      this.takeIrq();
    }

    if (s.cpsr & FLAG_T) {
      // THUMB: PC visible = decoded+4.
      const pc = s.r[15];
      const fetchAddr = (pc - 4) >>> 0;
      const instr = this.bus.read16(fetchAddr);
      s.r[15] = (pc + 2) >>> 0;
      thumbExecute(this, instr);
      // After execute, if PC wasn't flushed we keep walking forward — the
      // architectural PC view is pc+4 for the next instruction.
      this.cycles += 1;
      return 1;
    } else {
      const pc = s.r[15];
      const fetchAddr = (pc - 8) >>> 0;
      const instr = this.bus.read32(fetchAddr);
      s.r[15] = (pc + 4) >>> 0;
      armExecute(this, instr);
      this.cycles += 1;
      return 1;
    }
  }

  // Trigger exception entry — called from arm/thumb dispatch.
  softwareInterrupt(comment: number): void {
    if (this.bios && this.bios.handleSwi(comment)) {
      // HLE handled it — no real exception.
      return;
    }
    const s = this.state;
    const inThumb = (s.cpsr & FLAG_T) !== 0;
    const ret = inThumb ? (s.r[15] - 2) >>> 0 : (s.r[15] - 4) >>> 0;
    s.enterException(Mode.SVC, 0x08, ret, false);
    this.flushPipeline();
  }

  // Take an IRQ exception — drives the IRQ vector at 0x18.
  takeIrq(): void {
    const s = this.state;
    const inThumb = (s.cpsr & FLAG_T) !== 0;
    // Saved PC must point to next-to-execute instruction + 4 (the LR offset
    // ARM expects for IRQ is +4, so we save current PC and let the handler
    // subtract 4 in its return).
    const ret = inThumb ? (s.r[15]) >>> 0 : (s.r[15] - 4) >>> 0;
    s.enterException(Mode.IRQ, 0x18, ret, false);
    this.flushPipeline();
  }

  // Halt — handled by HALTCNT BIOS HLE.
  halt(): void { this.state.halted = true; }
}
