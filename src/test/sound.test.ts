// PSG (channels 1-4) + DirectSound stereo tests. Register-level only —
// no audio device needed; we drive Sound.step() with CPU cycles and
// inspect the interleaved-stereo float output directly.

import { describe, it, expect } from 'vitest';
import { Sound } from '../io/sound';
import { Dma } from '../io/dma';
import { Bus } from '../memory/bus';
import { Io } from '../io/io';
import { Timers } from '../io/timers';
import { Irq } from '../io/irq';
import { Keypad } from '../io/keypad';
import { Ppu } from '../ppu/ppu';
import { Cpu } from '../cpu/cpu';

const stubDma = { triggerSoundFifo: () => {} } as unknown as Dma;

// Master on, full L/R volume, all four PSG channels routed both sides,
// PSG ratio 100%. One channel at envelope volume 15 then produces
// samples of amplitude 15 * ((7+1)/8) * 1.0 / 120 = 0.125 per side.
function makeSound(): Sound {
  const s = new Sound(stubDma);
  s.writeReg16(0x84, 0x80);   // SOUNDCNT_X: master enable
  s.writeReg16(0x80, 0xFF77); // SOUNDCNT_L: vol L=R=7, all channels L+R
  s.writeReg16(0x82, 0x0002); // SOUNDCNT_H: PSG ratio 100%
  return s;
}

const AMP = 0.125; // single PSG channel, vol 15, full master, 100% ratio

function lefts(buf: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 2) out.push(buf[i]);
  return out;
}
function rights(buf: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 1; i < buf.length; i += 2) out.push(buf[i]);
  return out;
}

// freq=1792 → duty step every (2048-1792)*16 = 4096 cycles = 8 output
// samples; one full 8-step waveform = 64 samples.
const SQ_FREQ = 1792;

describe('PSG channel 1: square wave', () => {
  it.each([
    [0, 8],   // 12.5%
    [1, 16],  // 25%
    [2, 32],  // 50%
    [3, 48],  // 75%
  ])('duty %i has %i high samples per 64-sample waveform', (duty, expectHigh) => {
    const s = makeSound();
    s.writeReg16(0x62, (15 << 12) | (duty << 6)); // env init 15, no envelope
    s.writeReg16(0x64, 0x8000 | SQ_FREQ);         // trigger
    s.step(512 * 64);
    const L = lefts(s.drainOutput());
    expect(L.length).toBe(64);
    expect(L.filter((v) => v > 0).length).toBe(expectHigh);
    // Square is centered: every sample is ±AMP.
    for (const v of L) expect(Math.abs(v)).toBeCloseTo(AMP, 6);
  });

  it('envelope decreases volume every (period × 1/64s) tick', () => {
    const s = makeSound();
    s.writeReg16(0x62, (15 << 12) | (1 << 8)); // init 15, decrease, period 1
    s.writeReg16(0x64, 0x8000 | SQ_FREQ);
    expect(s.ch1.vol).toBe(15);
    s.step(8 * 32768); // envelope clocks on frame-sequencer step 7
    expect(s.ch1.vol).toBe(14);
    s.drainOutput();
    s.step(8 * 32768);
    expect(s.ch1.vol).toBe(13);
    // Output amplitude follows the envelope.
    const L = lefts(s.drainOutput());
    expect(Math.abs(L[L.length - 1])).toBeCloseTo(AMP * 13 / 15, 6);
  });

  it('envelope increase mode raises volume', () => {
    const s = makeSound();
    s.writeReg16(0x62, (1 << 12) | (1 << 11) | (1 << 8)); // init 1, increase, period 1
    s.writeReg16(0x64, 0x8000 | SQ_FREQ);
    s.step(8 * 32768);
    expect(s.ch1.vol).toBe(2);
  });

  it('length expiry clears the SOUNDCNT_X active bit and silences output', () => {
    const s = makeSound();
    s.writeReg16(0x62, (15 << 12) | 62);             // length counter = 64-62 = 2
    s.writeReg16(0x64, 0x8000 | 0x4000 | SQ_FREQ);   // trigger + length enable
    expect(s.readReg16(0x84) & 1).toBe(1);
    // Length clocks at 256 Hz = frame-sequencer steps 0 and 2; the 2nd
    // tick lands on the 3rd sequencer step (3 × 32768 cycles).
    s.step(3 * 32768);
    expect(s.readReg16(0x84) & 1).toBe(0);
    s.drainOutput();
    s.step(512 * 8);
    expect(Array.from(s.drainOutput()).every((v) => v === 0)).toBe(true);
  });

  it('sweep overflow at trigger disables the channel immediately', () => {
    const s = makeSound();
    s.writeReg16(0x60, (1 << 4) | 1);     // period 1, addition, shift 1
    s.writeReg16(0x62, 15 << 12);
    s.writeReg16(0x64, 0x8000 | 2000);    // 2000 + (2000>>1) > 2047
    expect(s.readReg16(0x84) & 1).toBe(0);
  });

  it('sweep raises frequency at 128 Hz then disables on overflow', () => {
    const s = makeSound();
    s.writeReg16(0x60, (1 << 4) | 2);     // period 1, addition, shift 2
    s.writeReg16(0x62, 15 << 12);
    s.writeReg16(0x64, 0x8000 | 1024);
    expect(s.readReg16(0x84) & 1).toBe(1);
    s.step(3 * 32768);  // sequencer step 2 → 1024 + 256 = 1280
    expect(s.ch1.freq).toBe(1280);
    expect(s.readReg16(0x84) & 1).toBe(1);
    s.step(4 * 32768);  // sequencer step 6 → 1280 + 320 = 1600
    expect(s.ch1.freq).toBe(1600);
    expect(s.readReg16(0x84) & 1).toBe(1);
    s.step(4 * 32768);  // next step 2 → 1600 + 400 = 2000, lookahead 2500 overflows
    expect(s.ch1.freq).toBe(2000);
    expect(s.readReg16(0x84) & 1).toBe(0);
  });

  it('DAC off (env init 0, decrease) keeps the channel inactive on trigger', () => {
    const s = makeSound();
    s.writeReg16(0x62, 0);
    s.writeReg16(0x64, 0x8000 | SQ_FREQ);
    expect(s.readReg16(0x84) & 1).toBe(0);
  });
});

describe('PSG channel 2: square wave (no sweep)', () => {
  it('produces a 25% duty waveform via 0x68/0x6C', () => {
    const s = makeSound();
    s.writeReg16(0x68, (15 << 12) | (1 << 6));
    s.writeReg16(0x6C, 0x8000 | SQ_FREQ);
    expect(s.readReg16(0x84) & 2).toBe(2);
    s.step(512 * 64);
    const L = lefts(s.drainOutput());
    expect(L.filter((v) => v > 0).length).toBe(16);
  });

  it('length expiry clears active bit 1', () => {
    const s = makeSound();
    s.writeReg16(0x68, (15 << 12) | 63);            // counter = 1
    s.writeReg16(0x6C, 0x8000 | 0x4000 | SQ_FREQ);
    s.step(32768); // first length tick
    expect(s.readReg16(0x84) & 2).toBe(0);
  });
});

describe('PSG channel 3: wave output', () => {
  it('CPU wave RAM access goes to the non-playing bank', () => {
    const s = makeSound();
    s.writeReg16(0x70, 0x00);            // play bank 0 → CPU sees bank 1
    s.writeReg16(0x90, 0xBEEF);
    expect(s.readReg16(0x90)).toBe(0xBEEF);
    s.writeReg16(0x70, 0x40);            // play bank 1 → CPU sees bank 0
    expect(s.readReg16(0x90)).toBe(0x0000);
    s.writeReg16(0x90, 0x1234);
    expect(s.readReg16(0x90)).toBe(0x1234);
    s.writeReg16(0x70, 0x00);            // back: bank 1 contents preserved
    expect(s.readReg16(0x90)).toBe(0xBEEF);
  });

  // Fill bank 0 with the nibble ramp 0,1,2,...,15,0,1,...,15 (high
  // nibble of each byte plays first).
  function fillRamp(s: Sound): void {
    s.writeReg16(0x70, 0x40); // select bank 1 → CPU writes land in bank 0
    for (let off = 0; off < 16; off += 2) {
      const b0 = (((off * 2) % 16) << 4) | ((off * 2 + 1) % 16);
      const b1 = ((((off + 1) * 2) % 16) << 4) | (((off + 1) * 2 + 1) % 16);
      s.writeReg16(0x90 + off, b0 | (b1 << 8));
    }
  }

  it('plays samples in order, high nibble first, at 100% volume', () => {
    const s = makeSound();
    fillRamp(s);
    s.writeReg16(0x70, 0x80);          // playback on, bank 0, 32-sample mode
    s.writeReg16(0x72, 1 << 13);       // volume code 1 = 100%
    s.writeReg16(0x74, 0x8000 | 1984); // sample step = 512 cycles = 1 output sample
    expect(s.readReg16(0x84) & 4).toBe(4);
    s.step(512 * 32);
    const L = lefts(s.drainOutput());
    for (let k = 0; k < 32; k++) {
      // Each output sample is taken right after the wave position
      // advances, so output k holds wave index (k+1) mod 32.
      const nib = ((k + 1) & 31) % 16;
      expect(L[k]).toBeCloseTo((nib * 2 - 15) / 120, 6);
    }
  });

  it.each([
    [2 << 13, 0.5],      // volume code 2 = 50%
    [3 << 13, 0.25],     // volume code 3 = 25%
    [0x8000, 0.75],      // bit 15 = force 75% (overrides code)
    [0 << 13, 0],        // volume code 0 = mute
  ])('volume control 0x%s scales output by %f', (volBits, factor) => {
    const s = makeSound();
    fillRamp(s);
    s.writeReg16(0x70, 0x80);
    s.writeReg16(0x72, volBits as number);
    s.writeReg16(0x74, 0x8000 | 1984);
    s.step(512 * 4);
    const L = lefts(s.drainOutput());
    for (let k = 0; k < 4; k++) {
      const nib = ((k + 1) & 31) % 16;
      expect(L[k]).toBeCloseTo(((nib * 2 - 15) * (factor as number)) / 120, 6);
    }
  });

  it('64-sample dimension plays across both banks', () => {
    const s = makeSound();
    fillRamp(s);                       // ramp in bank 0
    s.writeReg16(0x70, 0x40);          // CPU → bank 0... now select bank 1 to fill it
    s.writeReg16(0x70, 0x00);          // play bank 0 → CPU writes bank 1
    for (let off = 0; off < 16; off += 2) s.writeReg16(0x90 + off, 0xFFFF); // bank 1 all 15s
    s.writeReg16(0x70, 0x80 | 0x20);   // playback, bank 0, 64-sample mode
    s.writeReg16(0x72, 1 << 13);
    s.writeReg16(0x74, 0x8000 | 1984);
    s.step(512 * 64);
    const L = lefts(s.drainOutput());
    // Samples 32..62 come from bank 1 (all nibbles 15).
    for (let k = 32; k < 62; k++) {
      expect(L[k]).toBeCloseTo((15 * 2 - 15) / 120, 6);
    }
    // Earlier samples follow the bank-0 ramp.
    expect(L[0]).toBeCloseTo((1 * 2 - 15) / 120, 6);
  });

  it('length expiry clears active bit 2', () => {
    const s = makeSound();
    s.writeReg16(0x70, 0x80);
    s.writeReg16(0x72, (1 << 13) | 255);          // counter = 256-255 = 1
    s.writeReg16(0x74, 0x8000 | 0x4000 | 1984);
    expect(s.readReg16(0x84) & 4).toBe(4);
    s.step(32768);
    expect(s.readReg16(0x84) & 4).toBe(0);
  });
});

describe('PSG channel 4: noise', () => {
  it('7-bit LFSR repeats with period 127', () => {
    const s = makeSound();
    s.writeReg16(0x78, 15 << 12);
    s.writeReg16(0x7C, 0x8000 | 0x08); // trigger, 7-bit width
    const seq1: number[] = [];
    const seq2: number[] = [];
    for (let i = 0; i < 127; i++) { s.ch4.clock(); seq1.push(s.ch4.outBit()); }
    for (let i = 0; i < 127; i++) { s.ch4.clock(); seq2.push(s.ch4.outBit()); }
    expect(seq2).toEqual(seq1);
    expect(seq1.some((b) => b === 0)).toBe(true);
    expect(seq1.some((b) => b === 1)).toBe(true);
  });

  it('15-bit LFSR does NOT repeat with period 127', () => {
    const s = makeSound();
    s.writeReg16(0x78, 15 << 12);
    s.writeReg16(0x7C, 0x8000); // trigger, 15-bit width
    const seq1: number[] = [];
    const seq2: number[] = [];
    for (let i = 0; i < 127; i++) { s.ch4.clock(); seq1.push(s.ch4.outBit()); }
    for (let i = 0; i < 127; i++) { s.ch4.clock(); seq2.push(s.ch4.outBit()); }
    expect(seq2).not.toEqual(seq1);
  });

  it('emits ±vol samples while running and obeys the envelope', () => {
    const s = makeSound();
    s.writeReg16(0x78, (15 << 12) | (1 << 8)); // init 15, decrease, period 1
    s.writeReg16(0x7C, 0x8000 | 0x01);         // divisor 1, shift 0
    s.step(512 * 32);
    const L = lefts(s.drainOutput());
    for (const v of L) expect(Math.abs(v)).toBeCloseTo(AMP, 6);
    expect(L.some((v) => v > 0)).toBe(true);
    expect(L.some((v) => v < 0)).toBe(true);
    s.step(8 * 32768); // one envelope tick
    expect(s.ch4.vol).toBe(14);
  });

  it('length expiry clears active bit 3', () => {
    const s = makeSound();
    s.writeReg16(0x78, (15 << 12) | 63);
    s.writeReg16(0x7C, 0x8000 | 0x4000);
    expect(s.readReg16(0x84) & 8).toBe(8);
    s.step(32768);
    expect(s.readReg16(0x84) & 8).toBe(0);
  });
});

describe('PSG control: SOUNDCNT_L/H/X', () => {
  it('master disable silences output and write-protects PSG registers', () => {
    const s = new Sound(stubDma);
    s.writeReg16(0x62, 0xF040);
    expect(s.readReg16(0x62)).toBe(0);
    s.step(512 * 4);
    expect(s.drainOutput().length).toBe(0);
  });

  it('disabling the master zeroes PSG registers and kills active channels', () => {
    const s = makeSound();
    s.writeReg16(0x62, (15 << 12) | (2 << 6));
    s.writeReg16(0x64, 0x8000 | SQ_FREQ);
    expect(s.readReg16(0x62)).toBe(0xF080);
    expect(s.readReg16(0x84) & 1).toBe(1);
    s.writeReg16(0x84, 0);
    s.writeReg16(0x84, 0x80);
    expect(s.readReg16(0x62)).toBe(0);
    expect(s.readReg16(0x80)).toBe(0);
    expect(s.readReg16(0x84) & 0xF).toBe(0);
  });

  it('hard-left pan: right side is exactly silent', () => {
    const s = makeSound();
    s.writeReg16(0x80, 0x1077); // ch1 LEFT only, master vol 7/7
    s.writeReg16(0x62, 15 << 12);
    s.writeReg16(0x64, 0x8000 | SQ_FREQ);
    s.step(512 * 64);
    const out = s.drainOutput();
    const lsum = lefts(out).reduce((a, v) => a + Math.abs(v), 0);
    const rsum = rights(out).reduce((a, v) => a + Math.abs(v), 0);
    expect(rsum).toBe(0);
    expect(lsum).toBeGreaterThan(0);
  });

  it('hard-right pan: left side is exactly silent', () => {
    const s = makeSound();
    s.writeReg16(0x80, 0x0177); // ch1 RIGHT only
    s.writeReg16(0x62, 15 << 12);
    s.writeReg16(0x64, 0x8000 | SQ_FREQ);
    s.step(512 * 64);
    const out = s.drainOutput();
    const lsum = lefts(out).reduce((a, v) => a + Math.abs(v), 0);
    const rsum = rights(out).reduce((a, v) => a + Math.abs(v), 0);
    expect(lsum).toBe(0);
    expect(rsum).toBeGreaterThan(0);
  });

  it('per-side master volume scales each side independently', () => {
    const s = makeSound();
    // ch1 both sides; vol L=7 (full), R=3 (half).
    s.writeReg16(0x80, 0x1100 | (7 << 4) | 3);
    s.writeReg16(0x62, 15 << 12);
    s.writeReg16(0x64, 0x8000 | SQ_FREQ);
    s.step(512 * 8);
    const out = s.drainOutput();
    expect(Math.abs(out[0])).toBeCloseTo(AMP, 6);          // left: (7+1)/8
    expect(Math.abs(out[1])).toBeCloseTo(AMP * 0.5, 6);    // right: (3+1)/8
  });

  it('SOUNDCNT_H PSG ratio (25%/50%) scales the PSG mix', () => {
    for (const [bits, factor] of [[0, 0.25], [1, 0.5]] as const) {
      const s = makeSound();
      s.writeReg16(0x82, bits);
      s.writeReg16(0x62, 15 << 12);
      s.writeReg16(0x64, 0x8000 | SQ_FREQ);
      s.step(512 * 8);
      const out = s.drainOutput();
      expect(Math.abs(out[0])).toBeCloseTo(AMP * factor, 6);
    }
  });
});

describe('DirectSound stereo routing', () => {
  it('FIFO A routed LEFT only at 100% volume', () => {
    const s = new Sound(stubDma);
    s.writeReg16(0x84, 0x80);
    s.writeReg16(0x82, 0x0204); // A left enable (bit 9) + A 100% (bit 2), timer 0
    for (let i = 0; i < 4; i++) s.pushA(0x40);
    s.onTimerOverflow(0);
    expect(s.curA).toBe(0x40);
    s.step(512);
    const out = s.drainOutput();
    expect(out[0]).toBeCloseTo(64 / 256, 6); // left
    expect(out[1]).toBe(0);                  // right
  });

  it('FIFO B routed RIGHT only; 50% volume halves the sample', () => {
    const s = new Sound(stubDma);
    s.writeReg16(0x84, 0x80);
    s.writeReg16(0x82, 0x1000); // B right enable (bit 12), B 50% (bit 3 clear), timer 0
    for (let i = 0; i < 4; i++) s.pushB(0x80); // -128
    s.onTimerOverflow(0);
    expect(s.curB).toBe(-128);
    s.step(512);
    const out = s.drainOutput();
    expect(out[0]).toBe(0);                       // left
    expect(out[1]).toBeCloseTo(-128 * 0.5 / 256, 6); // right
  });

  it('held FIFO sample is repeated at the output rate between drains', () => {
    const s = new Sound(stubDma);
    s.writeReg16(0x84, 0x80);
    s.writeReg16(0x82, 0x0304); // A both sides, 100%
    s.pushA(0x20);
    s.onTimerOverflow(0);
    s.step(512 * 4); // four output samples, no further drain
    const L = lefts(s.drainOutput());
    expect(L.length).toBe(4);
    for (const v of L) expect(v).toBeCloseTo(32 / 256, 6);
  });
});

// MMIO routing through the real Io/Bus plumbing.
function makeRig() {
  const bus = new Bus();
  const irq = new Irq();
  const keypad = new Keypad();
  const dma = new Dma(bus, irq);
  const timers = new Timers(irq);
  const ppu = new Ppu(bus, irq, dma);
  const cpu = new Cpu(bus);
  const io = new Io(bus, ppu, dma, timers, irq, keypad, cpu);
  const sound = new Sound(dma);
  io.sound = sound;
  timers.sound = sound;
  bus.attachIo(io);
  bus.attachSave({ read: () => 0xFF, write: () => {} });
  bus.loadRom(new Uint8Array(0x100));
  return { bus, sound };
}

describe('Sound MMIO routing via Io', () => {
  it('applies GBATEK read masks (length/frequency/trigger are write-only)', () => {
    const { bus } = makeRig();
    bus.write16(0x04000084, 0x80);
    bus.write16(0x04000062, 0xF7BF);            // length bits 0-5 write-only
    expect(bus.read16(0x04000062)).toBe(0xF780);
    bus.write16(0x04000064, 0x4000 | 1792);     // freq + trigger read as 0
    expect(bus.read16(0x04000064)).toBe(0x4000);
    expect(bus.read16(0x04000066)).toBe(0);     // unused gap
  });

  it('SOUNDCNT_X reads live channel-active flags', () => {
    const { bus } = makeRig();
    bus.write16(0x04000084, 0x80);
    expect(bus.read16(0x04000084)).toBe(0x80);
    bus.write16(0x04000062, 15 << 12);
    bus.write16(0x04000064, 0x8000 | 1792);
    expect(bus.read16(0x04000084)).toBe(0x81);
  });

  it('byte writes RMW against the raw latch, not the masked readback', () => {
    const { bus } = makeRig();
    bus.write16(0x04000084, 0x80);
    bus.write16(0x04000062, 0x0080);    // duty 2
    bus.write8(0x04000063, 0x57);       // envelope byte only
    expect(bus.read16(0x04000062)).toBe(0x5780);
    bus.write8(0x04000062, 0x40);       // duty byte only (duty 1)
    expect(bus.read16(0x04000062)).toBe(0x5740);
  });

  it('FIFO accepts byte writes (one sample per byte)', () => {
    const { bus, sound } = makeRig();
    bus.write8(0x040000A0, 0x12);
    expect(sound.countA).toBe(1);
    bus.write8(0x040000A4, 0x34);
    expect(sound.countB).toBe(1);
  });

  it('wave RAM byte access targets the non-playing bank', () => {
    const { bus, sound } = makeRig();
    bus.write16(0x04000084, 0x80);
    bus.write16(0x04000070, 0x00);      // play bank 0 → CPU sees bank 1
    bus.write8(0x04000090, 0xAB);
    expect(sound.ch3.ram[16]).toBe(0xAB);
    expect(bus.read8(0x04000090)).toBe(0xAB);
  });

  it('SOUNDBIAS (0x088) still round-trips through the raw mirror', () => {
    const { bus } = makeRig();
    bus.write16(0x04000088, 0x0200);
    expect(bus.read16(0x04000088)).toBe(0x0200);
  });
});
