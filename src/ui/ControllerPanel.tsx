import { useEffect, useRef, useState } from 'react';

interface PadSnapshot {
  id: string;
  mapping: string;
  buttons: Array<{ pressed: boolean; value: number }>;
  axes: number[];
}

// Live diagnostic panel for the connected controller. Shows every
// button index with its pressed state and every axis with its value,
// so you can see exactly which physical buttons map to which indices
// on YOUR controller — useful when the standard W3C mapping doesn't
// match the device (PS5 DualSense on macOS Safari, generic USB pads).
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
    <div className="cp-overlay" onClick={onClose}>
      <div className="cp-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cp-header">
          <div className="cp-title">Controller</div>
          <button className="cp-close" onClick={onClose}>×</button>
        </div>
        {!snap ? (
          <div className="cp-empty">
            No controller detected.<br />
            Connect a gamepad and press any button to wake it.
          </div>
        ) : (
          <>
            <div className="cp-meta">
              <div><b>Device</b> {snap.id}</div>
              <div><b>Mapping</b> {snap.mapping}</div>
            </div>
            <div className="cp-section">
              <div className="cp-section-title">Buttons</div>
              <div className="cp-buttons">
                {snap.buttons.map((b, i) => (
                  <div key={i} className={`cp-btn ${b.pressed ? 'lit' : ''}`}>
                    <div className="cp-btn-idx">{i}</div>
                    {b.value > 0 && b.value < 1 ? (
                      <div className="cp-btn-val">{b.value.toFixed(2)}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <div className="cp-section">
              <div className="cp-section-title">Axes</div>
              <div className="cp-axes">
                {snap.axes.map((v, i) => (
                  <div key={i} className="cp-axis">
                    <div className="cp-axis-label">{i}</div>
                    <div className="cp-axis-bar">
                      <div
                        className="cp-axis-fill"
                        style={{
                          left: v < 0 ? `${50 + v * 50}%` : '50%',
                          width: `${Math.abs(v) * 50}%`,
                          background: v < 0 ? '#5ba8ff' : '#ff7858',
                        }}
                      />
                    </div>
                    <div className="cp-axis-val">{v.toFixed(2)}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="cp-hint">
              Press a physical button on the controller and look for the
              index that lights up. That's the index you'd configure in
              the mapping table if remapping were on. (Remap UI not built
              yet — for now this confirms which buttons reach the
              browser.)
            </div>
          </>
        )}
      </div>
    </div>
  );
}
