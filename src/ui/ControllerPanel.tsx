import { useEffect, useRef, useState } from 'react';

interface PadSnapshot {
  id: string;
  mapping: string;
  buttons: Array<{ pressed: boolean; value: number }>;
  axes: number[];
}

export function ControllerPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [snap, setSnap] = useState<PadSnapshot | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    let stop = false;
    const tick = () => {
      if (stop) return;
      rafRef.current = requestAnimationFrame(tick);
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let pad: Gamepad | null = null;
      for (const p of pads) { if (p && p.connected) { pad = p; break; } }
      if (!pad) { setSnap(null); return; }
      setSnap({
        id: pad.id,
        mapping: pad.mapping || '(non-standard)',
        buttons: pad.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
        axes: Array.from(pad.axes),
      });
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { stop = true; cancelAnimationFrame(rafRef.current); };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[1000]"
      onClick={onClose}
    >
      <div
        className="bg-[#14141a] border border-[#2a2a30] rounded-lg p-4 min-w-[540px] max-w-[720px] max-h-[80vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-3 pb-2 border-b border-[#2a2a30]">
          <div className="text-sm font-bold tracking-wider">Controller</div>
          <button onClick={onClose} className="bg-transparent border-0 text-[#d8d8e0] text-lg cursor-pointer px-2 hover:text-white">×</button>
        </div>
        {!snap ? (
          <div className="py-8 text-center opacity-50 text-xs leading-relaxed">
            No controller detected.<br />
            Connect a gamepad and press any button to wake it.
          </div>
        ) : (
          <>
            <div className="text-[11px] opacity-70 mb-3 leading-snug">
              <div><b className="text-[var(--color-accent)] font-normal mr-1">Device</b>{snap.id}</div>
              <div><b className="text-[var(--color-accent)] font-normal mr-1">Mapping</b>{snap.mapping}</div>
            </div>
            <div className="my-3">
              <div className="text-[10px] uppercase tracking-widest opacity-50 mb-2">Buttons</div>
              <div className="grid grid-cols-8 gap-1">
                {snap.buttons.map((b, i) => (
                  <div
                    key={i}
                    className={`text-center text-[11px] p-2 rounded border transition-all relative ${
                      b.pressed
                        ? 'bg-[#4a8aff] border-[#6ea2ff] text-white shadow-[0_0_8px_rgba(74,138,255,0.5)]'
                        : 'bg-[#1c1c22] border-[#2a2a30]'
                    }`}
                  >
                    <div className="font-bold">{i}</div>
                    {b.value > 0 && b.value < 1 && (
                      <div className="text-[9px] opacity-70">{b.value.toFixed(2)}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="my-3">
              <div className="text-[10px] uppercase tracking-widest opacity-50 mb-2">Axes</div>
              <div className="flex flex-col gap-1.5">
                {snap.axes.map((v, i) => (
                  <div key={i} className="grid grid-cols-[24px_1fr_48px] gap-2 items-center text-[11px]">
                    <div className="opacity-50 text-right">{i}</div>
                    <div className="relative h-2 bg-[#1c1c22] border border-[#2a2a30] rounded-sm overflow-hidden">
                      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[#2a2a30]" />
                      <div
                        className="absolute top-0 bottom-0 min-w-px"
                        style={{
                          left: v < 0 ? `${50 + v * 50}%` : '50%',
                          width: `${Math.abs(v) * 50}%`,
                          background: v < 0 ? '#5ba8ff' : '#ff7858',
                        }}
                      />
                    </div>
                    <div className="opacity-70 font-mono">{v.toFixed(2)}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-[#2a2a30] text-[10px] opacity-50 leading-relaxed">
              Press a physical button on the controller and watch which index lights up.
              That's the index you'd configure if remapping were on. (Remap UI not built yet —
              for now this confirms which buttons reach the browser.)
            </div>
          </>
        )}
      </div>
    </div>
  );
}
