import { useEffect, useState } from 'react';
import type { Emulator } from '../emulator';
import { SignalTransport } from '../io/sio-signal';
import { LocalLoopback } from '../io/sio';

interface Props {
  open: boolean;
  emu: Emulator;
  onClose: () => void;
}

// Cache the live transport on the Sio so closing/re-opening the panel
// doesn't drop the connection. There's only ever one link active at a
// time, so a sentinel key is fine.
function getActive(sio: Emulator['io']['sio']): SignalTransport | null {
  const t = sio.transport;
  return t instanceof SignalTransport ? t : null;
}

// Tiny base32-like generator for default room codes. We want something
// readable enough to dictate over Discord — six chars from a 32-char
// alphabet ≈ 30 bits, enough that two random rooms basically never
// collide for the lifetime of a session.
function makeRoomCode(): string {
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/1/I/L/O
  let s = '';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 6; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

export function LinkPanel({ open, emu, onClose }: Props) {
  const [roomInput, setRoomInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-render on peer events. The transport itself is the source of
  // truth (live in emu.io.sio.transport); we just nudge React.
  const [, setTick] = useState(0);
  const nudge = () => setTick((t) => t + 1);

  // Keep our UI in sync with peer join/leave even if the panel was open
  // when the events happened.
  useEffect(() => {
    if (!open) return;
    const t = getActive(emu.io.sio);
    if (!t) return;
    const prevJoin = t.onPeerJoin;
    const prevLeave = t.onPeerLeave;
    t.onPeerJoin = (id) => { prevJoin?.(id); nudge(); };
    t.onPeerLeave = (id) => { prevLeave?.(id); nudge(); };
    return () => {
      t.onPeerJoin = prevJoin;
      t.onPeerLeave = prevLeave;
    };
  }, [open, emu]);

  if (!open) return null;

  const active = getActive(emu.io.sio);
  const connected = active?.isConnected() ?? false;

  const onCreate = async () => {
    setError(null);
    setBusy(true);
    const code = makeRoomCode();
    setRoomInput(code);
    try {
      await connectTo(emu, code, true);
      nudge();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onJoin = async () => {
    if (!roomInput.trim()) { setError('Enter a room code'); return; }
    setError(null);
    setBusy(true);
    try {
      await connectTo(emu, roomInput.trim().toUpperCase(), false);
      nudge();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    setBusy(true);
    try {
      await disconnect(emu);
      nudge();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[1000]"
      onClick={onClose}
    >
      <div
        className="bg-[#14141a] border border-[#2a2a30] rounded-lg p-5 w-full max-w-[460px] mx-2 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4 pb-3 border-b border-[#2a2a30]">
          <div>
            <div className="text-sm font-bold tracking-wider">Link Cable</div>
            <div className="text-[11px] opacity-50 mt-0.5">
              {active ? (connected ? 'peer connected' : 'waiting for peer…') : 'not connected'}
            </div>
          </div>
          <button onClick={onClose} className="bg-transparent border-0 text-[#d8d8e0] text-xl cursor-pointer px-2 hover:text-white">×</button>
        </div>

        {!active && (
          <div className="text-[11px] space-y-3">
            <div className="opacity-70 leading-relaxed">
              Connects two browsers over WebRTC. One side creates a room and
              shares the code; the other side joins with it. Trades and
              turn-based play work; real-time racing is wobbly until the next
              sync upgrade lands.
            </div>
            <button
              onClick={onCreate}
              disabled={busy}
              className="btn-default w-full py-2"
            >Create room</button>
            <div className="text-[10px] opacity-40 text-center">or</div>
            <div className="flex gap-2">
              <input
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
                placeholder="Room code"
                maxLength={6}
                className="flex-1 px-2 py-1.5 bg-[#1c1c22] border border-[#2a2a30] rounded text-xs font-mono uppercase"
              />
              <button onClick={onJoin} disabled={busy} className="btn-default px-4">Join</button>
            </div>
          </div>
        )}

        {active && (
          <div className="text-[11px] space-y-3">
            <div className="flex items-center gap-2">
              <div className="opacity-50">Room</div>
              <div className="font-mono text-base tracking-widest select-all bg-[#1c1c22] px-3 py-1.5 rounded border border-[#2a2a30]">
                {roomInput || '—'}
              </div>
              <button
                onClick={() => navigator.clipboard?.writeText(roomInput).catch(() => {})}
                className="btn-default text-[10px]"
                disabled={!roomInput}
              >Copy</button>
            </div>
            <div className="flex items-center gap-2">
              <div className="opacity-50">Status</div>
              <div className={connected ? 'text-green-400' : 'text-yellow-400'}>
                {connected ? '● connected' : '● searching'}
              </div>
            </div>
            <LinkDebug emu={emu} />

            <button
              onClick={onDisconnect}
              disabled={busy}
              className="btn-default w-full py-2 !text-red-300"
            >Disconnect</button>
          </div>
        )}

        {error && <div className="mt-3 text-[10px] text-red-400">{error}</div>}
      </div>
    </div>
  );
}

// Live debug strip — polls the Sio's view of the link state so we can
// see whether SD has actually gone high on the GBA side, what the
// peer's latest SIOMLT_SEND value is, and whether the game is
// actually exercising the link (SIOCNT writes change over time).
function LinkDebug({ emu }: { emu: Emulator }) {
  const [snap, setSnap] = useState({
    siocnt: 0, mlt: 0, m0: 0, m1: 0, master: true,
    ieSio: false, ifSio: false, seq: 0,
  });
  useEffect(() => {
    const id = setInterval(() => {
      const sio = emu.io.sio;
      // Read SIOCNT through the IO bridge so we get the post-overlay
      // value (SI/SD/ID computed from transport state).
      const siocnt = emu.io.read16(0x4000128) & 0xFFFF;
      setSnap({
        siocnt,
        mlt: sio.mltSend & 0xFFFF,
        m0: sio.multi[0] & 0xFFFF,
        m1: sio.multi[1] & 0xFFFF,
        master: sio.transport.isMaster(),
        ieSio: (emu.irq.ie & 0x80) !== 0,
        ifSio: (emu.irq.iflag & 0x80) !== 0,
        seq: sio.transferSeq,
      });
    }, 200);
    return () => clearInterval(id);
  }, [emu]);
  const bit = (b: number) => (snap.siocnt >> b) & 1;
  const Box = ({ label, on }: { label: string; on: boolean }) => (
    <div className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${on ? 'bg-green-900 text-green-300' : 'bg-[#1c1c22] text-gray-500'}`}>
      {label}{on ? '=1' : '=0'}
    </div>
  );
  return (
    <div className="text-[10px] font-mono opacity-80 bg-[#0e0e12] rounded p-2 space-y-1.5">
      <div className="opacity-60 text-[9px] uppercase tracking-wider">GBA view</div>
      <div className="flex gap-1 flex-wrap">
        <Box label="SI" on={bit(2) === 1} />
        <Box label="SD" on={bit(3) === 1} />
        <Box label="START" on={bit(7) === 1} />
        <Box label="IRQ" on={bit(14) === 1} />
        <div className="px-1.5 py-0.5 rounded bg-[#1c1c22] text-gray-400">
          ID={((snap.siocnt >> 4) & 3)}
        </div>
        <div className="px-1.5 py-0.5 rounded bg-[#1c1c22] text-gray-400">
          mode={((snap.siocnt >> 12) & 3)}
        </div>
      </div>
      <div className="flex gap-1 flex-wrap">
        <Box label="IE.sio" on={snap.ieSio} />
        <Box label="IF.sio" on={snap.ifSio} />
      </div>
      <div className="flex gap-3 text-[10px] opacity-70 flex-wrap">
        <div>SIOCNT=0x{snap.siocnt.toString(16).padStart(4, '0')}</div>
        <div>SEND=0x{snap.mlt.toString(16).padStart(4, '0')}</div>
        <div>M0=0x{snap.m0.toString(16).padStart(4, '0')}</div>
        <div>M1=0x{snap.m1.toString(16).padStart(4, '0')}</div>
        <div>seq={snap.seq}</div>
        <div>{snap.master ? 'master' : 'slave'}</div>
      </div>
      <SioTracer emu={emu} />
    </div>
  );
}

// Tiny debug helper: toggle the Sio access trace, then dump it to the
// browser console as a console.table. Lets us see exactly which SIO
// register the game is reading/writing at each PC during cable
// detection. Consecutive identical accesses are collapsed to one row
// with an `n=N` run length so busy-polling doesn't drown the output.
function SioTracer({ emu }: { emu: Emulator }) {
  const [on, setOn] = useState(emu.io.sio.traceOn);
  const toggle = () => {
    emu.io.sio.traceOn = !emu.io.sio.traceOn;
    setOn(emu.io.sio.traceOn);
  };
  const dump = () => {
    const t = emu.io.sio.trace;
    if (t.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[sio-trace] empty (enable the trace, then perform the action you want to capture)');
      return;
    }
    const rows = t.map((e) => ({
      seq: e.seq,
      pc: '0x' + (e.pc >>> 0).toString(16),
      op: e.op,
      addr: '0x040001' + e.off.toString(16).padStart(2, '0'),
      val: '0x' + e.val.toString(16).padStart(4, '0'),
      n: e.n,
    }));
    // eslint-disable-next-line no-console
    console.log(`[sio-trace] ${rows.length} unique entries (last ${emu.io.sio.trace[emu.io.sio.trace.length - 1].seq})`);
    // eslint-disable-next-line no-console
    console.table(rows);
  };
  const clear = () => { emu.io.sio.clearTrace(); };
  return (
    <div className="flex gap-2 items-center text-[10px] mt-1">
      <label className="flex items-center gap-1 cursor-pointer">
        <input type="checkbox" checked={on} onChange={toggle} className="w-3 h-3" />
        <span className="opacity-60">SIO trace</span>
      </label>
      <button onClick={dump} className="btn-default !text-[10px] !py-0.5">Dump to console</button>
      <button onClick={clear} className="btn-default !text-[10px] !py-0.5">Clear</button>
    </div>
  );
}

async function connectTo(emu: Emulator, code: string, isMaster: boolean): Promise<void> {
  // Drop any prior transport first — joining a new room while another
  // is live would leak the previous DataChannel + WebSocket.
  await disconnect(emu);
  const t = new SignalTransport(emu.io.sio);
  // Assign now so isConnected() and the UI panel can already see "this
  // is the active transport" while we wait for the WS handshake.
  emu.io.sio.transport = t;
  await t.connect({ roomId: code, isMaster });
}

async function disconnect(emu: Emulator): Promise<void> {
  const t = getActive(emu.io.sio);
  if (t) {
    await t.disconnect();
    emu.io.sio.transport = new LocalLoopback();
  }
}
