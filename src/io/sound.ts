import type { Dma } from './dma';

// GBA sound: the two FIFO-driven DirectSound PCM channels (A/B) plus
// the four legacy GB PSG channels (tone+sweep, tone, wave, noise).
//
// How DirectSound works on the GBA:
//   1. Game sets up a Timer (0 or 1) with a reload value that makes
//      it overflow at the desired output sample rate, e.g. 32768 Hz.
//   2. Game sets up DMA1 (for FIFO A) or DMA2 (for FIFO B) with
//      timing = special, src = wave buffer in EWRAM, dst = FIFO addr,
//      count = 4 words.
//   3. Timer overflow drains 1 sample (signed 8-bit) from the FIFO.
//   4. When the FIFO has ≤16 of its 32 bytes remaining, DMA fires and
//      pushes 4 words = 16 bytes back in.
//   5. SOUNDCNT_H picks which timer drives each channel, the per-
//      channel volume (50% / 100%), and which sides (L/R) get the
//      output.
//   6. SOUNDCNT_X bit 7 is the master enable.
//
// Output strategy: we emit interleaved stereo float pairs [L, R] at a
// fixed 32768 Hz (one pair every 512 CPU cycles), driven by step()
// from the emulator's main loop. DirectSound samples are zero-order
// held between timer overflows (matching the hardware DAC, which also
// holds the last sample) and resampled to the output rate implicitly.
// The PSG generators are clocked in CPU cycles, with the GB frame
// sequencer (512 Hz) derived from the same cycle counter:
//   length counters @ 256 Hz, sweep @ 128 Hz, envelopes @ 64 Hz.

const FIFO_SIZE = 32;
const SAMPLE_CYCLES = 512;   // 16777216 / 512 = 32768 Hz output rate
const SEQ_CYCLES = 32768;    // 512 Hz frame sequencer

// The four square-wave duty patterns (12.5%, 25%, 50%, 75%), 8 phase
// steps each. Phase advances at 8× the tone frequency.
const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
];

// SOUNDCNT_H bits 0-1: PSG mix ratio. 3 is "prohibited"; treat as 100%.
const PSG_RATIO = [0.25, 0.5, 1.0, 1.0];

// Square channel (1 and 2). Channel 2 simply never gets sweep writes.
export class SquareChannel {
  enabled = false;
  dacOn = false;          // envelope initial volume 0 + decrease = DAC off
  duty = 0;
  dutyPos = 0;
  freq = 0;               // 11-bit; tone = 131072/(2048-freq) Hz
  freqTimer = 0;          // CPU cycles until next duty step
  lengthCounter = 0;      // 0..64, counts down at 256 Hz when enabled
  lengthEnable = false;
  envInit = 0; envDir = 0; envPeriod = 0; envTimer = 0;
  vol = 0;                // current envelope volume 0..15
  // Sweep (channel 1 only).
  sweepShift = 0; sweepDir = 0; sweepPeriod = 0;
  sweepTimer = 0; sweepEnabled = false; shadowFreq = 0;

  reset(): void {
    this.enabled = this.dacOn = this.lengthEnable = this.sweepEnabled = false;
    this.duty = this.dutyPos = this.freq = this.freqTimer = 0;
    this.lengthCounter = 0;
    this.envInit = this.envDir = this.envPeriod = this.envTimer = this.vol = 0;
    this.sweepShift = this.sweepDir = this.sweepPeriod = 0;
    this.sweepTimer = this.shadowFreq = 0;
  }

  // NR10 / SOUND1CNT_L
  writeSweep(v: number): void {
    this.sweepShift = v & 7;
    this.sweepDir = (v >> 3) & 1;
    this.sweepPeriod = (v >> 4) & 7;
  }
  // NRx1+NRx2 / SOUNDxCNT_H: length, duty, envelope
  writeDutyLenEnv(v: number): void {
    this.lengthCounter = 64 - (v & 63);
    this.duty = (v >> 6) & 3;
    this.envPeriod = (v >> 8) & 7;
    this.envDir = (v >> 11) & 1;
    this.envInit = (v >> 12) & 15;
    this.dacOn = (v & 0xF800) !== 0;
    if (!this.dacOn) this.enabled = false;
  }
  // NRx3+NRx4 / SOUNDxCNT_X: frequency, length enable, trigger
  writeFreqCtl(v: number): void {
    this.freq = v & 0x7FF;
    this.lengthEnable = (v & 0x4000) !== 0;
    if (v & 0x8000) this.trigger();
  }

  private period(): number { return (2048 - this.freq) * 16; }

  trigger(): void {
    this.enabled = this.dacOn;
    if (this.lengthCounter === 0) this.lengthCounter = 64;
    this.freqTimer = this.period();
    this.dutyPos = 0;
    this.vol = this.envInit;
    this.envTimer = this.envPeriod || 8;
    this.shadowFreq = this.freq;
    this.sweepTimer = this.sweepPeriod || 8;
    this.sweepEnabled = this.sweepPeriod > 0 || this.sweepShift > 0;
    // Immediate overflow check when shift > 0 (can kill the channel
    // right at the trigger — GB/GBA hardware behavior).
    if (this.sweepShift > 0) this.sweepCalc();
  }

  // Compute the next sweep frequency; flags overflow by disabling.
  private sweepCalc(): number {
    const d = this.shadowFreq >> this.sweepShift;
    const nf = this.sweepDir ? this.shadowFreq - d : this.shadowFreq + d;
    if (nf > 2047) this.enabled = false;
    return nf;
  }

  clockSweep(): void {
    if (--this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepPeriod || 8;
    if (!this.sweepEnabled || this.sweepPeriod === 0) return;
    const nf = this.sweepCalc();
    if (nf <= 2047 && this.sweepShift > 0) {
      this.shadowFreq = nf;
      this.freq = nf;
      this.sweepCalc(); // second overflow check with the new shadow
    }
  }
  clockLength(): void {
    if (this.lengthEnable && this.lengthCounter > 0) {
      if (--this.lengthCounter === 0) this.enabled = false;
    }
  }
  clockEnvelope(): void {
    if (this.envPeriod === 0) return;
    if (--this.envTimer > 0) return;
    this.envTimer = this.envPeriod;
    if (this.envDir) { if (this.vol < 15) this.vol++; }
    else             { if (this.vol > 0)  this.vol--; }
  }

  advance(cycles: number): void {
    if (!this.enabled) return;
    this.freqTimer -= cycles;
    if (this.freqTimer <= 0) {
      const p = this.period();
      const n = Math.floor(-this.freqTimer / p) + 1;
      this.freqTimer += n * p;
      this.dutyPos = (this.dutyPos + n) & 7;
    }
  }

  // Digital output in -15..15. We center the square around 0 (±vol)
  // instead of the hardware's unipolar DAC + analog highpass, so a
  // silenced/expired channel contributes exactly 0 with no DC step.
  output(): number {
    if (!this.enabled || !this.dacOn) return 0;
    return DUTY[this.duty][this.dutyPos] ? this.vol : -this.vol;
  }
}

// Wave channel (3). GBA-specific: two 32-sample (16-byte) wave RAM
// banks; bit 5 of SOUND3CNT_L selects 32- or 64-sample dimension and
// bit 6 selects the playing bank. CPU reads/writes at 0x4000090..9F
// always access the bank NOT selected for playback (GBATEK).
export class WaveChannel {
  enabled = false;
  playback = false;       // SOUND3CNT_L bit 7 (acts as the DAC enable)
  dimension = 0;          // 0 = one 32-sample bank, 1 = 64 samples across both
  bank = 0;
  lengthCounter = 0;      // 0..256
  lengthEnable = false;
  volCode = 0;            // 0=0%, 1=100%, 2=50%, 3=25%
  force75 = false;        // SOUND3CNT_H bit 15: force 75%
  freq = 0;
  freqTimer = 0;
  pos = 0;                // sample position 0..31 (or 0..63)
  sample = 0;             // latched 4-bit sample
  ram = new Uint8Array(32); // bytes 0-15 = bank 0, bytes 16-31 = bank 1

  reset(): void {
    this.enabled = this.playback = this.lengthEnable = this.force75 = false;
    this.dimension = this.bank = this.volCode = 0;
    this.lengthCounter = this.freq = this.freqTimer = this.pos = this.sample = 0;
    // Wave RAM contents survive a PSG master-disable on hardware.
  }

  writeCtl(v: number): void {   // SOUND3CNT_L
    this.dimension = (v >> 5) & 1;
    this.bank = (v >> 6) & 1;
    this.playback = (v & 0x80) !== 0;
    if (!this.playback) this.enabled = false;
  }
  writeLenVol(v: number): void { // SOUND3CNT_H
    this.lengthCounter = 256 - (v & 0xFF);
    this.volCode = (v >> 13) & 3;
    this.force75 = (v & 0x8000) !== 0;
  }
  writeFreqCtl(v: number): void { // SOUND3CNT_X
    this.freq = v & 0x7FF;
    this.lengthEnable = (v & 0x4000) !== 0;
    if (v & 0x8000) this.trigger();
  }

  // CPU-visible wave RAM: the non-playing bank.
  ramIndex(byteOff: number): number { return (this.bank ^ 1) * 16 + (byteOff & 15); }
  readRam8(off: number): number { return this.ram[this.ramIndex(off)]; }
  writeRam8(off: number, v: number): void { this.ram[this.ramIndex(off)] = v & 0xFF; }

  private period(): number { return (2048 - this.freq) * 8; }

  trigger(): void {
    this.enabled = this.playback;
    if (this.lengthCounter === 0) this.lengthCounter = 256;
    this.pos = 0;
    this.freqTimer = this.period();
    this.latchSample();
  }

  private latchSample(): void {
    // In 64-sample mode playback starts at the selected bank and runs
    // through both; in 32-sample mode it loops the selected bank.
    const idx = this.dimension
      ? (this.bank * 32 + this.pos) & 63
      : this.bank * 32 + (this.pos & 31);
    const byte = this.ram[idx >> 1];
    this.sample = (idx & 1) ? (byte & 0xF) : (byte >> 4); // high nibble first
  }

  clockLength(): void {
    if (this.lengthEnable && this.lengthCounter > 0) {
      if (--this.lengthCounter === 0) this.enabled = false;
    }
  }

  advance(cycles: number): void {
    if (!this.enabled) return;
    this.freqTimer -= cycles;
    if (this.freqTimer <= 0) {
      const p = this.period();
      const n = Math.floor(-this.freqTimer / p) + 1;
      this.freqTimer += n * p;
      this.pos = (this.pos + n) % (this.dimension ? 64 : 32);
      this.latchSample();
    }
  }

  // Centered digital output in -15..15 (float — volume scaling can
  // produce fractions). Center-then-scale so volume 0 emits 0, not DC.
  output(): number {
    if (!this.enabled || !this.playback) return 0;
    const centered = this.sample * 2 - 15;
    if (this.force75) return centered * 0.75;
    switch (this.volCode) {
      case 0: return 0;
      case 1: return centered;
      case 2: return centered * 0.5;
      default: return centered * 0.25;
    }
  }
}

// Noise channel (4). 15-bit LFSR (optionally folded to 7-bit width).
export class NoiseChannel {
  enabled = false;
  dacOn = false;
  lengthCounter = 0;
  lengthEnable = false;
  envInit = 0; envDir = 0; envPeriod = 0; envTimer = 0;
  vol = 0;
  divisor = 0; width7 = false; shift = 0;
  lfsr = 0x7FFF;
  freqTimer = 0;

  reset(): void {
    this.enabled = this.dacOn = this.lengthEnable = this.width7 = false;
    this.lengthCounter = 0;
    this.envInit = this.envDir = this.envPeriod = this.envTimer = this.vol = 0;
    this.divisor = this.shift = this.freqTimer = 0;
    this.lfsr = 0x7FFF;
  }

  writeLenEnv(v: number): void { // SOUND4CNT_L
    this.lengthCounter = 64 - (v & 63);
    this.envPeriod = (v >> 8) & 7;
    this.envDir = (v >> 11) & 1;
    this.envInit = (v >> 12) & 15;
    this.dacOn = (v & 0xF800) !== 0;
    if (!this.dacOn) this.enabled = false;
  }
  writeCtl(v: number): void { // SOUND4CNT_H
    this.divisor = v & 7;
    this.width7 = (v & 0x08) !== 0;
    this.shift = (v >> 4) & 15;
    this.lengthEnable = (v & 0x4000) !== 0;
    if (v & 0x8000) this.trigger();
  }

  // LFSR step rate = 524288 / r / 2^(shift+1) Hz with r=0.5 for
  // divisor code 0. In CPU cycles: (32 or 64*divisor) << shift.
  private period(): number {
    return (this.divisor === 0 ? 32 : 64 * this.divisor) << this.shift;
  }

  trigger(): void {
    this.enabled = this.dacOn;
    if (this.lengthCounter === 0) this.lengthCounter = 64;
    this.freqTimer = this.period();
    this.vol = this.envInit;
    this.envTimer = this.envPeriod || 8;
    this.lfsr = 0x7FFF;
  }

  clock(): void {
    const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
    this.lfsr = (this.lfsr >> 1) | (bit << 14);
    if (this.width7) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
  }
  // Channel output bit: inverted LFSR bit 0.
  outBit(): number { return (~this.lfsr) & 1; }

  clockLength(): void {
    if (this.lengthEnable && this.lengthCounter > 0) {
      if (--this.lengthCounter === 0) this.enabled = false;
    }
  }
  clockEnvelope(): void {
    if (this.envPeriod === 0) return;
    if (--this.envTimer > 0) return;
    this.envTimer = this.envPeriod;
    if (this.envDir) { if (this.vol < 15) this.vol++; }
    else             { if (this.vol > 0)  this.vol--; }
  }

  advance(cycles: number): void {
    if (!this.enabled) return;
    this.freqTimer -= cycles;
    const p = this.period();
    // Bounded: p >= 32 and advance() chunks are <= 512 cycles, so this
    // loops at most 17 times.
    while (this.freqTimer <= 0) {
      this.freqTimer += p;
      this.clock();
    }
  }

  output(): number {
    if (!this.enabled || !this.dacOn) return 0;
    return this.outBit() ? this.vol : -this.vol;
  }
}

export class Sound {
  // Each FIFO is a 32-entry ring of 8-bit signed PCM samples.
  fifoA = new Int8Array(FIFO_SIZE);
  fifoB = new Int8Array(FIFO_SIZE);
  headA = 0; tailA = 0; countA = 0;
  headB = 0; tailB = 0; countB = 0;
  // Most-recently-drained sample value for each channel; held until the
  // next timer overflow drains the FIFO again. Real hardware does the
  // same — DAC output stays at the last sample between drains.
  curA = 0;
  curB = 0;

  soundcntL = 0;  // PSG master L/R volume + per-channel L/R enables
  soundcntH = 0;
  soundcntX = 0;

  ch1 = new SquareChannel();
  ch2 = new SquareChannel();
  ch3 = new WaveChannel();
  ch4 = new NoiseChannel();

  // Raw write-latch for 0x60..0x84 (16-bit regs, index = (addr-0x60)>>1).
  // Readback applies GBATEK masks; byte writes read-modify-write against
  // THIS (not the masked readback) so e.g. a byte write to the envelope
  // half of SOUND1CNT_H can't zero the write-only length bits.
  regRaw = new Uint16Array(0x13);

  // Cycle accumulators for the 32768 Hz output sampler and the 512 Hz
  // PSG frame sequencer.
  private sampleAcc = 0;
  private seqAcc = 0;
  private seqStep = 0;

  // Per-frame INTERLEAVED STEREO sample buffer [L, R, L, R, ...] the
  // host audio sink drains each runFrame(). One GBA frame at 32768 Hz
  // is ~547 pairs = ~1094 floats; 4096 leaves margin for skipped drains.
  output = new Float32Array(4096);
  outputLen = 0;

  // Output sample rate. Fixed: we emit one stereo pair every 512 CPU
  // cycles regardless of the DirectSound timer rate (FIFO samples are
  // zero-order held between timer overflows, like the hardware DAC).
  sampleRate = 32768;

  constructor(public dma: Dma) {}

  reset(): void {
    this.headA = this.tailA = this.countA = 0;
    this.headB = this.tailB = this.countB = 0;
    this.curA = this.curB = 0;
    this.outputLen = 0;
    this.soundcntL = 0;
    this.soundcntH = 0;
    this.soundcntX = 0;
    this.sampleAcc = this.seqAcc = this.seqStep = 0;
    this.ch1.reset(); this.ch2.reset(); this.ch3.reset(); this.ch4.reset();
    this.regRaw.fill(0);
  }

  // Push one byte into the FIFO (called when the game writes to the
  // FIFO_A_L/H or FIFO_B_L/H MMIO ports, including via DMA).
  pushA(b: number): void {
    if (this.countA >= FIFO_SIZE) return;
    this.fifoA[this.tailA] = (b << 24) >> 24;  // sign-extend to int8
    this.tailA = (this.tailA + 1) % FIFO_SIZE;
    this.countA++;
  }
  pushB(b: number): void {
    if (this.countB >= FIFO_SIZE) return;
    this.fifoB[this.tailB] = (b << 24) >> 24;
    this.tailB = (this.tailB + 1) % FIFO_SIZE;
    this.countB++;
  }

  // ---- MMIO ----------------------------------------------------------

  // 16-bit write to the sound block, addr = IO offset 0x60..0x9E.
  writeReg16(addr: number, v: number): void {
    v &= 0xFFFF;
    // Wave RAM is not gated by the master enable.
    if (addr >= 0x90 && addr <= 0x9E) {
      const off = addr - 0x90;
      this.ch3.writeRam8(off, v & 0xFF);
      this.ch3.writeRam8(off + 1, v >> 8);
      return;
    }
    // While master-disabled, PSG registers 0x60..0x81 are write-
    // protected and read as zero (GBATEK). SOUNDCNT_H/X stay writable.
    if (addr <= 0x80 && !(this.soundcntX & 0x80)) return;
    // Latch the raw value for byte-write RMW. Trigger bits are not
    // sticky — clear them so a later low-byte RMW can't re-trigger.
    const isCtlX = addr === 0x64 || addr === 0x6C || addr === 0x74 || addr === 0x7C;
    this.regRaw[(addr - 0x60) >> 1] = isCtlX ? v & 0x7FFF : v;
    switch (addr) {
      case 0x60: this.ch1.writeSweep(v); break;
      case 0x62: this.ch1.writeDutyLenEnv(v); break;
      case 0x64: this.ch1.writeFreqCtl(v); break;
      case 0x68: this.ch2.writeDutyLenEnv(v); break;
      case 0x6C: this.ch2.writeFreqCtl(v); break;
      case 0x70: this.ch3.writeCtl(v); break;
      case 0x72: this.ch3.writeLenVol(v); break;
      case 0x74: this.ch3.writeFreqCtl(v); break;
      case 0x78: this.ch4.writeLenEnv(v); break;
      case 0x7C: this.ch4.writeCtl(v); break;
      case 0x80: this.soundcntL = v; break;
      case 0x82: this.writeSoundcntH(v); break;
      case 0x84: this.writeSoundcntX(v); break;
    }
  }

  // 16-bit read, addr = IO offset 0x60..0x9E. GBATEK read masks: length
  // fields, frequencies and trigger bits are write-only and read as 0.
  readReg16(addr: number): number {
    if (addr >= 0x90 && addr <= 0x9E) {
      const off = addr - 0x90;
      return this.ch3.readRam8(off) | (this.ch3.readRam8(off + 1) << 8);
    }
    switch (addr) {
      case 0x60: return this.regRaw[0x00] & 0x007F;
      case 0x62: return this.regRaw[0x01] & 0xFFC0;
      case 0x64: return this.regRaw[0x02] & 0x4000;
      case 0x68: return this.regRaw[0x04] & 0xFFC0;
      case 0x6C: return this.regRaw[0x06] & 0x4000;
      case 0x70: return this.regRaw[0x08] & 0x00E0;
      case 0x72: return this.regRaw[0x09] & 0xE000;
      case 0x74: return this.regRaw[0x0A] & 0x4000;
      case 0x78: return this.regRaw[0x0C] & 0xFF00;
      case 0x7C: return this.regRaw[0x0E] & 0x40FF;
      case 0x80: return this.soundcntL & 0xFF77;
      case 0x82: return this.soundcntH & 0x770F;
      // SOUNDCNT_X: master enable + READ-ONLY live channel-active flags.
      case 0x84:
        return (this.soundcntX & 0x80)
          | (this.ch1.enabled ? 1 : 0)
          | (this.ch2.enabled ? 2 : 0)
          | (this.ch3.enabled ? 4 : 0)
          | (this.ch4.enabled ? 8 : 0);
    }
    return 0; // unused gaps (0x66, 0x6A, 0x6E, 0x76, 0x7A, 0x7E, 0x86)
  }

  // Raw (unmasked) value for byte-write read-modify-write in Io.write8.
  rawRead16(addr: number): number {
    if (addr === 0x82) return this.soundcntH;
    if (addr === 0x84) return this.soundcntX;
    if (addr >= 0x60 && addr <= 0x80) return this.regRaw[(addr - 0x60) >> 1];
    return 0;
  }

  // Bit 11 of SOUNDCNT_H is the FIFO A reset; bit 15 is FIFO B reset.
  // Writing the bit clears that FIFO.
  writeSoundcntH(v: number): void {
    this.soundcntH = v & 0xFFFF;
    if (v & 0x0800) { this.headA = this.tailA = this.countA = 0; }
    if (v & 0x8000) { this.headB = this.tailB = this.countB = 0; }
  }
  writeSoundcntX(v: number): void {
    const wasOn = (this.soundcntX & 0x80) !== 0;
    this.soundcntX = v & 0x80; // only bit 7 is writable
    if (!(v & 0x80)) {
      this.headA = this.tailA = this.countA = 0;
      this.headB = this.tailB = this.countB = 0;
      this.curA = this.curB = 0;
      // Master disable zeroes all PSG registers (0x60..0x81) — they
      // must be re-initialized after re-enabling (GBATEK).
      if (wasOn) {
        this.ch1.reset(); this.ch2.reset(); this.ch3.reset(); this.ch4.reset();
        this.soundcntL = 0;
        this.regRaw.fill(0, 0, 0x11);
      }
    } else if (!wasOn) {
      this.sampleAcc = this.seqAcc = this.seqStep = 0;
    }
  }

  // ---- DirectSound FIFO drain (from Timers.overflow) ------------------

  // Called from Timers.overflow(timerIdx). Drains one sample from any
  // FIFO whose timer-select bit matches this timer. (Sample EMISSION is
  // handled by step(); the drained value is held in curA/curB.)
  onTimerOverflow(timerIdx: 0 | 1): void {
    if (!(this.soundcntX & 0x80)) return; // master disable → silence
    const timerA = (this.soundcntH >> 10) & 1;
    const timerB = (this.soundcntH >> 14) & 1;

    if (timerA === timerIdx) {
      if (this.countA > 0) {
        this.curA = this.fifoA[this.headA];
        this.headA = (this.headA + 1) % FIFO_SIZE;
        this.countA--;
      }
      // Refill via DMA1 special-timing if the FIFO is below half-full.
      if (this.countA <= 16) this.dma.triggerSoundFifo(1);
    }
    if (timerB === timerIdx) {
      if (this.countB > 0) {
        this.curB = this.fifoB[this.headB];
        this.headB = (this.headB + 1) % FIFO_SIZE;
        this.countB--;
      }
      if (this.countB <= 16) this.dma.triggerSoundFifo(2);
    }
  }

  // ---- Cycle-driven sampler + PSG clocks ------------------------------

  // Step the PSG generators and emit output samples. Called from the
  // emulator main loop with the same per-batch cycle counts Timers get.
  step(cycles: number): void {
    if (!(this.soundcntX & 0x80)) return; // master off: nothing ticks
    let rem = cycles;
    while (rem > 0) {
      // Process up to the next output-sample boundary so generator
      // state is correct at the instant each sample is taken.
      let n = SAMPLE_CYCLES - this.sampleAcc;
      if (n > rem) n = rem;
      this.ch1.advance(n);
      this.ch2.advance(n);
      this.ch3.advance(n);
      this.ch4.advance(n);
      this.seqAcc += n;
      if (this.seqAcc >= SEQ_CYCLES) {
        this.seqAcc -= SEQ_CYCLES;
        this.tickSequencer();
      }
      this.sampleAcc += n;
      if (this.sampleAcc >= SAMPLE_CYCLES) {
        this.sampleAcc = 0;
        this.emitSample();
      }
      rem -= n;
    }
  }

  // 512 Hz frame sequencer: lengths at 256 Hz (even steps), sweep at
  // 128 Hz (steps 2 and 6), envelopes at 64 Hz (step 7).
  private tickSequencer(): void {
    const s = this.seqStep;
    this.seqStep = (s + 1) & 7;
    if ((s & 1) === 0) {
      this.ch1.clockLength();
      this.ch2.clockLength();
      this.ch3.clockLength();
      this.ch4.clockLength();
    }
    if (s === 2 || s === 6) this.ch1.clockSweep();
    if (s === 7) {
      this.ch1.clockEnvelope();
      this.ch2.clockEnvelope();
      this.ch4.clockEnvelope();
    }
  }

  private emitSample(): void {
    // PSG digital outputs, each in -15..15.
    const o1 = this.ch1.output();
    const o2 = this.ch2.output();
    const o3 = this.ch3.output();
    const o4 = this.ch4.output();
    const cl = this.soundcntL;
    // Per-channel routing: SOUNDCNT_L bits 8-11 = right, 12-15 = left.
    let r = 0, l = 0;
    if (cl & 0x0100) r += o1;
    if (cl & 0x0200) r += o2;
    if (cl & 0x0400) r += o3;
    if (cl & 0x0800) r += o4;
    if (cl & 0x1000) l += o1;
    if (cl & 0x2000) l += o2;
    if (cl & 0x4000) l += o3;
    if (cl & 0x8000) l += o4;
    // Master side volume (0-7 → 1/8..8/8), PSG ratio (25/50/100%), then
    // scale so all four channels at max volume sum to ±0.5 (one PSG
    // channel at full volume = ±0.125, comparable to one DirectSound
    // channel's ±0.5).
    const ratio = PSG_RATIO[this.soundcntH & 3];
    r *= (((cl >> 0) & 7) + 1) / 8 * ratio / 120;
    l *= (((cl >> 4) & 7) + 1) / 8 * ratio / 120;
    // DirectSound: SOUNDCNT_H bit 2/3 = A/B volume ratio (50%/100%);
    // bits 8/9 = A right/left enable, bits 12/13 = B right/left enable.
    const aGain = (this.soundcntH & 0x04) ? 1.0 : 0.5;
    const bGain = (this.soundcntH & 0x08) ? 1.0 : 0.5;
    const a = (this.curA * aGain) / 256;  // ±0.5 at 100%
    const b = (this.curB * bGain) / 256;
    if (this.soundcntH & 0x0100) r += a;
    if (this.soundcntH & 0x0200) l += a;
    if (this.soundcntH & 0x1000) r += b;
    if (this.soundcntH & 0x2000) l += b;
    if (this.outputLen + 2 <= this.output.length) {
      this.output[this.outputLen++] = l < -1 ? -1 : l > 1 ? 1 : l;
      this.output[this.outputLen++] = r < -1 ? -1 : r > 1 ? 1 : r;
    }
  }

  // Pop the per-frame samples for the audio sink. Returns a NEW typed
  // array (small copy) so the caller can hand it directly to Web Audio.
  // Layout: interleaved stereo [L, R, L, R, ...].
  drainOutput(): Float32Array {
    const out = this.output.slice(0, this.outputLen);
    this.outputLen = 0;
    return out;
  }
}
