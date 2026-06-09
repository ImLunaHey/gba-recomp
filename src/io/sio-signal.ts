import type { LinkTransport, MultiplayResult, Sio } from './sio';

// Link transport that relays SIO state through the same WebSocket
// we use for signaling — no RTCPeerConnection involved. Backed by
// the SignalRoom Durable Object (src/worker.ts). One WS per peer
// per room; the DO forwards `{type:'state', to: peerId}` messages
// to the addressed peer.
//
// Why not direct WebRTC?
// - Firefox in various privacy configs silently refuses to gather
//   any ICE candidates, killing the DataChannel before it can open.
// - TURN requires Cloudflare Realtime to be provisioned and routable
//   from the user's network; both of those have failure modes that
//   surface as opaque "ICE failed" errors with no real recovery.
// - For 1:1 link-cable traffic (single small message every 33 ms)
//   the per-byte cost of relaying through CF's edge is negligible,
//   and the connect-success rate goes from "depends on your network
//   and browser" to "if you can load the page, the link works."
//
// Latency budget vs direct peer-to-peer: ~20-50 ms one-way through
// CF's nearest colo, vs ~5-20 ms over LAN with raw DataChannel. Fine
// for Pokemon-style turn-based traffic; noticeable for real-time
// racing, but Phase B-2 (lockstep / input-delay) is the right fix
// for racing anyway — direct-P2P only buys us a few ms there.

const TICK_MS = 33;

type StateMsg = {
  mlt: number;
  d32lo: number;
  d32hi: number;
  d8: number;
  // Master-only fields — when the local Sio just completed a Multi-
  // play transfer, we snapshot SIOMULTI[0..3] and a monotonic seq so
  // the slave can apply the same values + fire its IRQ. seq=0 means
  // "no transfer has happened yet"; receivers watch for it advancing.
  seq: number;
  m0: number;
  m1: number;
  m2: number;
  m3: number;
};

interface WireMsg {
  type: 'self' | 'peer-join' | 'peer-leave' | 'state';
  to?: string;
  from?: string;
  peerId?: string;
  peers?: string[];
  payload?: unknown;
}

export interface SignalOptions {
  roomId: string;
  isMaster: boolean;
  // Optional override of the signaling base URL. Defaults to the
  // current page's origin. Useful for tests pointing at a local mock.
  signalingBase?: string;
}

export class SignalTransport implements LinkTransport {
  private ws: WebSocket | null = null;
  private peerId: string | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private peerLatest: StateMsg = { mlt: 0xFFFF, d32lo: 0xFFFF, d32hi: 0xFFFF, d8: 0xFF, seq: 0, m0: 0, m1: 0, m2: 0, m3: 0 };
  private peerLatestAt = 0;
  private master = true;
  // Last peer transferSeq we processed. We're slave-side and the
  // peer is master; when this advances, we mirror their SIOMULTI[]
  // snapshot into our Sio and fire SIO IRQ. Tracked unsigned mod 2^32.
  private lastAppliedSeq = 0;

  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  // eslint-disable-next-line no-unused-vars
  constructor(private sio: Sio) {}

  async connect(opts: SignalOptions): Promise<void> {
    this.master = opts.isMaster;
    const base = opts.signalingBase ?? defaultSignalingBase();
    const url = `${base}/api/signal/${encodeURIComponent(opts.roomId)}`;
    console.log('[link] connecting', url);
    await this.openWs(url);
    this.tickHandle = setInterval(() => this.broadcast(), TICK_MS);
  }

  async disconnect(): Promise<void> {
    if (this.tickHandle !== null) { clearInterval(this.tickHandle); this.tickHandle = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* */ } this.ws = null; }
    this.peerId = null;
    this.peerLatest = { mlt: 0xFFFF, d32lo: 0xFFFF, d32hi: 0xFFFF, d8: 0xFF, seq: 0, m0: 0, m1: 0, m2: 0, m3: 0 };
    this.lastAppliedSeq = 0;
  }

  isConnected(): boolean {
    // Connectivity is "the WebSocket is alive and the peer is still in
    // the room", not "we recently received data". When two tabs share
    // a browser only one is foreground at a time; the background tab's
    // 33 ms broadcast tick gets throttled (sometimes to 60+ s between
    // ticks), so a freshness-based check makes SD flicker on/off and
    // games like Mario Kart see no cable. The DO emits peer-leave the
    // moment the peer's WS actually drops — that's our real disconnect
    // signal, and it's plenty.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    return this.peerId !== null;
  }
  isMaster(): boolean { return this.master; }

  multiplayExchange(localData: number): MultiplayResult {
    const peer = this.isConnected() ? (this.peerLatest.mlt & 0xFFFF) : 0xFFFF;
    return { d0: localData & 0xFFFF, d1: peer, d2: 0xFFFF, d3: 0xFFFF, error: false };
  }
  normal32Exchange(_localData: number): number {
    if (!this.isConnected()) return 0xFFFFFFFF;
    return ((this.peerLatest.d32hi << 16) | this.peerLatest.d32lo) >>> 0;
  }
  normal8Exchange(_localData: number): number {
    return this.isConnected() ? (this.peerLatest.d8 & 0xFF) : 0xFF;
  }

  // ----------------------------------------------------------------

  private openWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => { console.log('[link] WS open'); resolve(); };
      ws.onmessage = (ev) => this.onWire(ev.data as string);
      ws.onerror = () => {
        const err = new Error('signaling WebSocket error');
        this.onError?.(err);
        reject(err);
      };
      ws.onclose = () => {
        console.log('[link] WS closed');
        if (this.peerId) this.onPeerLeave?.(this.peerId);
        this.peerId = null;
      };
    });
  }

  private onWire(raw: string): void {
    let msg: WireMsg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'self':
        // Anyone already in the room becomes our 1:1 peer.
        if (msg.peers && msg.peers.length > 0) {
          this.peerId = msg.peers[0];
          // Seed peerLatestAt so isConnected can flip true at the
          // moment we know who they are, even before their first
          // state message arrives.
          this.peerLatestAt = performance.now();
          this.onPeerJoin?.(this.peerId);
        }
        break;
      case 'peer-join':
        if (msg.peerId && !this.peerId) {
          this.peerId = msg.peerId;
          this.peerLatestAt = performance.now();
          this.onPeerJoin?.(msg.peerId);
        }
        break;
      case 'peer-leave':
        if (msg.peerId && msg.peerId === this.peerId) {
          this.onPeerLeave?.(msg.peerId);
          this.peerId = null;
        }
        break;
      case 'state':
        if (msg.from === this.peerId && msg.payload) {
          const p = msg.payload as StateMsg;
          this.peerLatest = p;
          this.peerLatestAt = performance.now();
          // Slave-side: when the master's transferSeq advances, mirror
          // their SIOMULTI snapshot into our Sio and let it fire IRQ.
          // We don't gate on isMaster here — if the slave (us) happens
          // to also bump its own seq later, the same logic will run on
          // the other side, which is fine: each side ignores its own
          // master-only state.
          if (!this.master && p.seq !== 0 && p.seq !== this.lastAppliedSeq) {
            this.lastAppliedSeq = p.seq;
            this.sio.applyRemoteMultiplay(p.m0, p.m1, p.m2, p.m3, false);
          }
        }
        break;
    }
  }

  private broadcast(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.peerId) return;
    const sio = this.sio;
    const payload: StateMsg = {
      mlt: sio.mltSend & 0xFFFF,
      d32lo: sio.multi[0] & 0xFFFF,
      d32hi: sio.multi[1] & 0xFFFF,
      d8: sio.mltSend & 0xFF,
      seq: sio.transferSeq,
      m0: sio.multi[0] & 0xFFFF,
      m1: sio.multi[1] & 0xFFFF,
      m2: sio.multi[2] & 0xFFFF,
      m3: sio.multi[3] & 0xFFFF,
    };
    try {
      this.ws.send(JSON.stringify({ type: 'state', to: this.peerId, payload }));
    } catch { /* will recover next tick */ }
  }
}

function defaultSignalingBase(): string {
  const { protocol, host } = window.location;
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${host}`;
}
