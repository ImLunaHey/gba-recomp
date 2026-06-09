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
  multiplayExchange(localData: number): MultiplayResult {
    return { d0: localData & 0xFFFF, d1: 0xFFFF, d2: 0xFFFF, d3: 0xFFFF, error: false };
  }
  normal32Exchange(_localData: number): number { return 0xFFFFFFFF; }
  normal8Exchange(_localData: number): number { return 0xFF; }
}

// Transfer-complete latency in CPU cycles. Real hardware varies by
// baud; we use a single rough value (~33 µs at 16.78 MHz ≈ 550 cycles)
// so the START bit doesn't clear synchronously — games that poll
// SIOCNT.START would otherwise spin-detect the clear in a single MMIO
// read and skip whatever VBlank/IRQ wait they had. Picking a value
// roughly between "one MMIO write" and "one scanline" is the sweet
// spot: too low and we starve the game's wait loop, too high and slow
// games (Pokemon trade animation) feel sluggish.
const TRANSFER_CYCLES = 1024;

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

  // The transport is swappable at runtime so the UI can switch from
  // "no cable" loopback to a real WebRTC peer without restarting the
  // emulator.
  transport: LinkTransport = new LocalLoopback();

  constructor(public irq: Irq) {}

  // Advance the transfer countdown by `cyc` CPU cycles. Called from
  // Emulator.runFrame after each batch, same as PPU/Timers.
  step(cyc: number): void {
    if (!this.active) return;
    this.cyclesUntilDone -= cyc;
    if (this.cyclesUntilDone <= 0) this.complete();
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
  //                We always present as master (no incoming SC signal).
  //   bit 3  SD  — data ready (multi-play). High when all four GBAs
  //                are reachable. We set this from transport.isConnected.
  //   bits 4-5 multi-player ID. 0 = master.
  private readSiocnt(): number {
    let v = this.siocnt & ~0x000C;
    v &= ~0x0030;                              // ID = 0 (master)
    if (this.transport.isConnected()) v |= 0x0008;  // SD high
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
    if (mode === MODE_NORMAL_8 || mode === MODE_NORMAL_32 || mode === MODE_MULTI) {
      this.active = true;
      this.cyclesUntilDone = TRANSFER_CYCLES;
    } else {
      // UART — accepted, but we don't model the byte stream. Clear
      // START immediately so the game's wait loop doesn't hang.
      this.siocnt &= ~0x80;
    }
  }

  private complete(): void {
    this.active = false;
    if (this.activeMode === MODE_MULTI) {
      const r = this.transport.multiplayExchange(this.mltSend);
      this.multi[0] = r.d0 & 0xFFFF;
      this.multi[1] = r.d1 & 0xFFFF;
      this.multi[2] = r.d2 & 0xFFFF;
      this.multi[3] = r.d3 & 0xFFFF;
      if (r.error) this.siocnt |= 0x0040; else this.siocnt &= ~0x0040;
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
