import { Irq, IRQ_SIO } from './irq';

// Serial I/O — the GBA "link cable" controller. Five modes, picked by
// RCNT[15:14] + SIOCNT[13:12]:
//   RCNT[15:14]=00, SIOCNT[13:12]=00 -> Normal-8 / Normal-32  (1:1 link)
//   RCNT[15:14]=00, SIOCNT[13:12]=10 -> Multi-play             (up to 4 GBAs)
//   RCNT[15:14]=00, SIOCNT[13:12]=11 -> UART
//   RCNT[15:14]=01                    -> General-purpose / GPIO (RTC uses this)
//   RCNT[15:14]=10                    -> JOY-bus (GameCube)
//
// We model Normal-8/32 and Multi-play because those are what real games
// use over a link cable. UART and JOY-bus are accepted but the state
// machine just keeps START clear (no transfer ever completes).
//
// GPIO mode is handled by src/memory/rtc.ts via the cart-GPIO range, not
// here — we don't intercept RCNT.bit-banging for the RTC. Writes to RCNT
// in GPIO mode are stored in the raw IO mirror and ignored by Sio.
//
// All transfers go through a pluggable Transport. The default is a
// LocalLoopback that completes transfers immediately with 0xFFFF
// "no partner connected" data — which is what real hardware floats to
// when no cable is plugged in, and what most games interpret as "no
// link partner." Phase B will swap in a Trystero-based WebRTC transport.

export interface LinkTransport {
  // Called when the local GBA, in multi-play master mode, starts a
  // transfer. `localData` is what we'd send as the master payload.
  // Implementation should return the four-slot result array (master
  // slot 0 + up to 3 slave slots). Slots with no partner connected
  // must be 0xFFFF.
  multiplayExchange(localData: number): MultiplayResult;

  // Called when the local GBA, in Normal-32 mode, starts a transfer
  // as the master. Returns the 32-bit word read back into SIODATA32.
  // No partner -> 0xFFFFFFFF.
  normal32Exchange(localData: number): number;

  // Called when the local GBA, in Normal-8 mode, starts a transfer as
  // the master. Returns the 8-bit word read back into SIODATA8.
  normal8Exchange(localData: number): number;

  // Whether a remote partner is currently connected. Affects SIOCNT.SD
  // (data ready) and the multi-player ID stickiness during boot.
  isConnected(): boolean;

  // True when this end of the link is the master GBA (cable parent /
  // multi-player ID = 0). Implementations that don't model master/
  // slave should return true. Affects SIOCNT.SI (bit 2, slave
  // indicator) and the multi-player ID in bits 4-5.
  isMaster(): boolean;

  // Phase B-2 lockstep hook. When the local Sio kicks off a Multi-
  // play transfer as master, it calls requestMultiplay to ask the
  // peer for a synchronized response. The transport returns true if
  // it took the request (the callback will be invoked when the peer
  // responds or the transport gives up); false / undefined → Sio
  // falls back to the synchronous multiplayExchange path. The
  // callback may be invoked synchronously (LocalLoopback) or async
  // (WebSocket round-trip).
  requestMultiplay?(localData: number, onComplete: (r: MultiplayResult) => void): boolean;
}

export interface SioTraceEntry {
  seq: number;     // 1-based, monotonic; gives a stable order across the buffer
  pc: number;      // PC of the instruction that issued the IO access
  op: 'R' | 'W';
  off: number;     // 0x120, 0x128, 0x134, etc.
  val: number;
  n: number;       // run length of consecutive identical accesses
}

export interface MultiplayResult {
  // Slots 0-3. Master always populates 0; slaves 1-3 are 0xFFFF when no
  // partner is in that slot.
  d0: number; d1: number; d2: number; d3: number;
  // True if any peer reported a transfer-time error (the SIOCNT error
  // flag). Real hardware sets this on framing/timeout faults.
  error: boolean;
}

// Default transport: no partner ever connects. Multi-play returns "I'm
// the only one here," Normal-32 returns 0xFFFFFFFF, etc. Games that
// just touch link to detect "is anyone there" will see "no partner"
// and continue single-player.
export class LocalLoopback implements LinkTransport {
  isConnected(): boolean { return false; }
  isMaster(): boolean { return true; }
  multiplayExchange(localData: number): MultiplayResult {
    return { d0: localData & 0xFFFF, d1: 0xFFFF, d2: 0xFFFF, d3: 0xFFFF, error: false };
  }
  normal32Exchange(_localData: number): number { return 0xFFFFFFFF; }
  normal8Exchange(_localData: number): number { return 0xFF; }
}

// Multi-play transfer time, in CPU cycles, by baud. On real hardware
// this would be 12k–140k cycles depending on baud — the byte time of
// the master/slave wire exchange. We deliberately clamp to ≈ one full
// frame (280k cycles) here as a Phase B-1 workaround.
//
// Why: with a live peer connected and the game in Multi-play mode,
// the game's transfer loop pumps as fast as transfers complete. Real
// hardware paces this loop via the slave's actual response latency
// (slaves don't reply until their own game frame writes SIOMLT_SEND).
// We don't have that backpressure yet — slave data is just whatever
// the last 33 ms WebSocket broadcast carried — so a 12k-cycle
// transfer makes the master's logic tick ~23× per emu frame and the
// game runs visibly that fast.
//
// One-transfer-per-frame trades data freshness for correct game
// speed: cable detection still passes (a few seconds of probes), but
// per-frame state sync drops from ~24× to 1×. Phase B-2 (lockstep
// over the WS) will replace this clamp with real backpressure.
const MULTI_CYCLES_BY_BAUD = [280000, 280000, 280000, 280000];
// Normal-32 is a single 32-bit shift register at the chosen SO/SC
// rate. SIOCNT[1] picks 256 kHz (= 64 cycles/bit) or 2 MHz (= 8
// cycles/bit). 32 bits → ~2048 cycles slow / 256 cycles fast. Adds a
// short fudge for setup/teardown.
const NORMAL_CYCLES_SLOW = 2048;
const NORMAL_CYCLES_FAST = 256;

// SIOCNT[13:12] mode encoding:
//   00 = Normal-8, 01 = Normal-32, 10 = Multi-play, 11 = UART.
// Normal-8 and Normal-32 share a state path; UART is accepted but no
// transfer is ever scheduled.
const MODE_NORMAL_8  = 0;
const MODE_NORMAL_32 = 1;
const MODE_MULTI     = 2;

export class Sio {
  // Register backing — these are what reads return.
  // SIODATA32 (0x120 lo, 0x122 hi), SIOMULTI2/3 (0x124, 0x126),
  // SIOCNT (0x128), SIOMLT_SEND/SIODATA8 (0x12A), RCNT (0x134),
  // JOYCNT (0x140), JOY_RECV (0x150), JOY_TRANS (0x154), JOYSTAT (0x158).
  multi = new Uint16Array(4);  // 4 multi-play slots / SIODATA32 lo/hi mirror
  siocnt = 0;
  mltSend = 0;                  // SIOMLT_SEND (16-bit) / SIODATA8 (low byte)
  rcnt = 0;
  joycnt = 0;
  joyRecv = 0;
  joyTrans = 0;
  joystat = 0;

  // Pending transfer state machine. When SIOCNT[7] (START) is set the
  // master schedules a completion `cyclesUntilDone` later; once that
  // hits zero we publish the result and fire the IRQ.
  private cyclesUntilDone = 0;
  private active = false;
  private activeMode = MODE_NORMAL_8;
  private activeLen32 = false;  // Normal mode only: 1 = 32-bit, 0 = 8-bit

  // Monotonic counter: how many Multi-play transfers this Sio has
  // completed as the master. The remote slave's Sio watches this in
  // the broadcast state and, on advance, applies the same SIOMULTI
  // snapshot + fires SIO IRQ — that's how real hardware drives the
  // slave's transfer machinery without the slave's software setting
  // START. Wraps modulo 2^32; remote peer compares unsigned.
  transferSeq = 0;

  // Filled in by the transport's requestMultiplay callback when an
  // async lockstep response arrives before the cycle budget runs out.
  // complete() prefers this over the synchronous multiplayExchange.
  private pendingMulti: MultiplayResult | null = null;

  // The transport is swappable at runtime so the UI can switch from
  // "no cable" loopback to a real WebRTC peer without restarting the
  // emulator.
  transport: LinkTransport = new LocalLoopback();

  // Optional access trace. When enabled (via Sio.traceOn = true from
  // the UI), every SIO/RCNT/JOY read and write is logged with the PC
  // that issued it. Consecutive identical accesses collapse into a
  // single entry with an incremented count — otherwise a busy-wait
  // would saturate the buffer in a single transfer. Used to debug
  // games like Mario Kart whose cable detection rejects SD-high alone
  // and we need to see which register/value it's actually waiting on.
  trace: SioTraceEntry[] = [];
  traceOn = false;
  private traceCap = 4096;
  private traceSeq = 0;

  logTrace(op: 'R' | 'W', off: number, val: number, pc: number): void {
    if (!this.traceOn) return;
    const last = this.trace[this.trace.length - 1];
    if (last && last.pc === pc && last.op === op && last.off === off && last.val === val) {
      last.n++;
      return;
    }
    this.trace.push({ seq: ++this.traceSeq, pc, op, off, val, n: 1 });
    if (this.trace.length > this.traceCap) this.trace.shift();
  }

  clearTrace(): void { this.trace.length = 0; this.traceSeq = 0; }

  constructor(public irq: Irq) {}

  // Advance the transfer countdown by `cyc` CPU cycles. Called from
  // Emulator.runFrame after each batch, same as PPU/Timers.
  step(cyc: number): void {
    if (!this.active) return;
    this.cyclesUntilDone -= cyc;
    if (this.cyclesUntilDone <= 0) this.complete();
  }

  // Apply a Multi-play transfer that the *remote* master initiated.
  // The transport (slave side) calls this when it sees the master's
  // transferSeq advance. Mirrors what slave hardware does: latch the
  // four SIOMULTI slots and fire SIO IRQ if enabled.
  applyRemoteMultiplay(m0: number, m1: number, m2: number, m3: number, error: boolean): void {
    this.multi[0] = m0 & 0xFFFF;
    this.multi[1] = m1 & 0xFFFF;
    this.multi[2] = m2 & 0xFFFF;
    this.multi[3] = m3 & 0xFFFF;
    if (error) this.siocnt |= 0x0040; else this.siocnt &= ~0x0040;
    if (this.siocnt & 0x4000) this.irq.raise(IRQ_SIO);
  }

  // -------- read/write surface called from Io.read16/write16. --------

  read16(off: number): number {
    switch (off) {
      case 0x120: return this.multi[0];
      case 0x122: return this.multi[1];
      case 0x124: return this.multi[2];
      case 0x126: return this.multi[3];
      case 0x128: return this.readSiocnt();
      case 0x12A: return this.mltSend;
      case 0x134: return this.rcnt;
      case 0x140: return this.joycnt;
      case 0x150: return this.joyRecv & 0xFFFF;
      case 0x152: return (this.joyRecv >>> 16) & 0xFFFF;
      case 0x154: return this.joyTrans & 0xFFFF;
      case 0x156: return (this.joyTrans >>> 16) & 0xFFFF;
      case 0x158: return this.joystat;
    }
    return 0;
  }

  write16(off: number, v: number): void {
    v &= 0xFFFF;
    switch (off) {
      // SIODATA32 / SIOMULTI{0..3} — also writable: in Normal mode the
      // master loads its outgoing word here before raising START.
      case 0x120: this.multi[0] = v; return;
      case 0x122: this.multi[1] = v; return;
      case 0x124: this.multi[2] = v; return;
      case 0x126: this.multi[3] = v; return;
      case 0x128: this.writeSiocnt(v); return;
      case 0x12A: this.mltSend = v; return;
      case 0x134: this.rcnt = v; return;
      case 0x140: this.joycnt = (this.joycnt & ~0x07) | (v & 0x07); return;
      case 0x150: this.joyRecv = (this.joyRecv & 0xFFFF0000) | v; return;
      case 0x152: this.joyRecv = (this.joyRecv & 0x0000FFFF) | (v << 16); return;
      case 0x154: this.joyTrans = (this.joyTrans & 0xFFFF0000) | v; return;
      case 0x156: this.joyTrans = (this.joyTrans & 0x0000FFFF) | (v << 16); return;
      case 0x158: this.joystat = v & 0x3F; return;
    }
  }

  // -------- SIOCNT specifics. --------

  // SIOCNT read returns most of what was written, but a few bits are
  // hardware-driven:
  //   bit 2  SI  — slave indicator: 0 = parent / master link, 1 = child.
  //   bit 3  SD  — data ready (multi-play). High when all four GBAs
  //                are reachable. We set this from transport.isConnected.
  //   bits 4-5 multi-player ID. 0 = master, 1 = slave (we model 1:1
  //   only; IDs 2-3 would be additional slaves).
  private readSiocnt(): number {
    let v = this.siocnt & ~0x003C;             // clear SI, SD, ID
    const isMaster = this.transport.isMaster();
    if (!isMaster) v |= 0x0004;                // SI high (slave)
    if (this.transport.isConnected()) v |= 0x0008;  // SD high
    if (!isMaster) v |= 0x0010;                // ID = 1 (slave 1)
    return v;
  }

  private writeSiocnt(v: number): void {
    const wasStart = (this.siocnt & 0x80) !== 0;
    // Bits 2-5 are read-only on real hardware (status). Bits 0-1 (baud),
    // 7 (start), 12-13 (mode), 14 (IRQ), 6 (error clear-on-write) are
    // writable; we just store the lot and selectively ignore reads.
    this.siocnt = v;

    const start = (v & 0x80) !== 0;
    if (start && !wasStart) {
      // Transfer just kicked off. Figure out mode + queue completion.
      this.beginTransfer();
    } else if (!start) {
      // Software cleared START mid-transfer — abort.
      this.active = false;
      this.cyclesUntilDone = 0;
    }
  }

  private beginTransfer(): void {
    const mode = (this.siocnt >> 12) & 3;
    this.activeMode = mode;
    this.activeLen32 = mode === MODE_NORMAL_32;
    if (mode === MODE_NORMAL_8 || mode === MODE_NORMAL_32) {
      // Normal mode shift-clock: SIOCNT bit 1 picks 256 kHz (= slow)
      // vs 2 MHz (= fast). Bit 0 is SC direction (external vs
      // internal), which doesn't affect duration of the transfer in
      // our model — we always complete it.
      this.cyclesUntilDone = (this.siocnt & 2) ? NORMAL_CYCLES_FAST : NORMAL_CYCLES_SLOW;
      this.active = true;
    } else if (mode === MODE_MULTI) {
      this.cyclesUntilDone = MULTI_CYCLES_BY_BAUD[this.siocnt & 3];
      this.active = true;
      this.pendingMulti = null;
      // Lockstep: ask the transport for a synchronized peer response.
      // If it accepts the request, we'll force-complete the moment
      // the callback fires (typically before the cycle budget ends),
      // so the master's perceived transfer time becomes "real RTT to
      // the slave" instead of the artificial cycle clamp. If the
      // transport declines (LocalLoopback, or no peer yet), we fall
      // through and the cycle counter does the work as before.
      if (this.transport.requestMultiplay) {
        this.transport.requestMultiplay(this.mltSend, (r) => {
          // Only honor responses for the still-active transfer; a
          // late response after a follow-up transfer started would
          // otherwise overwrite the new one's pending state.
          if (!this.active || this.activeMode !== MODE_MULTI) return;
          this.pendingMulti = r;
          this.cyclesUntilDone = 0;
        });
      }
    } else {
      // UART — accepted, but we don't model the byte stream. Clear
      // START immediately so the game's wait loop doesn't hang.
      this.siocnt &= ~0x80;
    }
  }

  private complete(): void {
    this.active = false;
    if (this.activeMode === MODE_MULTI) {
      // Prefer the lockstep response if it arrived in time; fall back
      // to the synchronous "latest broadcast value" path otherwise.
      const r = this.pendingMulti ?? this.transport.multiplayExchange(this.mltSend);
      this.pendingMulti = null;
      this.multi[0] = r.d0 & 0xFFFF;
      this.multi[1] = r.d1 & 0xFFFF;
      this.multi[2] = r.d2 & 0xFFFF;
      this.multi[3] = r.d3 & 0xFFFF;
      if (r.error) this.siocnt |= 0x0040; else this.siocnt &= ~0x0040;
      // Bump seq so a watching slave Sio applies the same SIOMULTI
      // snapshot + IRQ as if its hardware had been pulled along.
      this.transferSeq = (this.transferSeq + 1) >>> 0;
    } else if (this.activeLen32) {
      // Normal-32. SIODATA32 = multi[0] (lo) | multi[1] (hi) — same
      // backing as multi-play slot 0/1.
      const out = (this.multi[1] << 16) | this.multi[0];
      const inp = this.transport.normal32Exchange(out) >>> 0;
      this.multi[0] = inp & 0xFFFF;
      this.multi[1] = (inp >>> 16) & 0xFFFF;
    } else {
      // Normal-8. SIODATA8 lives in the low byte of SIOMLT_SEND
      // (0x12A) — same register, different mode.
      const inp = this.transport.normal8Exchange(this.mltSend & 0xFF);
      this.mltSend = inp & 0xFF;
    }
    // Clear START to signal completion.
    this.siocnt &= ~0x80;
    if (this.siocnt & 0x4000) this.irq.raise(IRQ_SIO);
  }
}
