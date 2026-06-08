import { useEffect } from 'react';
import { Key, Keypad } from '../io/keypad';

// Standard Gamepad mapping (W3C) button indices. PS5 DualSense on macOS
// via Bluetooth maps to "standard" in Chrome and most Chromium-derived
// browsers (Edge, Brave, Arc); Safari uses a similar layout. Cross is
// button 0 ("A" in Xbox terminology) and Circle is button 1, which we
// route to GBA A and B respectively (matching the physical position of
// A/B on the GBA — the rightmost button is A).
const BUTTON_MAP: Array<[number, Key]> = [
  [0,  Key.A],       // Cross  / Xbox A  → GBA A
  [1,  Key.B],       // Circle / Xbox B  → GBA B
  [4,  Key.L],       // L1
  [5,  Key.R],       // R1
  [8,  Key.SELECT],  // Share / View
  [9,  Key.START],   // Options / Menu
  [12, Key.UP],
  [13, Key.DOWN],
  [14, Key.LEFT],
  [15, Key.RIGHT],
];

// Some controllers (or non-standard mappings) report the D-pad via the
// left analog stick instead. We synthesize D-pad presses from axis 0/1
// if they cross this threshold.
const STICK_THRESHOLD = 0.5;

interface UseGamepadOptions {
  keypad: Keypad;
  onConnected?: (name: string) => void;
  onDisconnected?: (name: string) => void;
}

export function useGamepad({ keypad, onConnected, onDisconnected }: UseGamepadOptions) {
  useEffect(() => {
    // Track which keys we've pressed via the gamepad so we can release
    // them cleanly when the button goes up (and not interfere with the
    // touch / keyboard paths releasing the same key).
    const heldByPad = new Set<Key>();
    let raf = 0;
    let stop = false;

    const press = (k: Key) => {
      if (heldByPad.has(k)) return;
      heldByPad.add(k);
      keypad.press(k);
    };
    const release = (k: Key) => {
      if (!heldByPad.has(k)) return;
      heldByPad.delete(k);
      keypad.release(k);
    };

    const tick = () => {
      if (stop) return;
      raf = requestAnimationFrame(tick);
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let pad: Gamepad | null = null;
      for (const p of pads) { if (p && p.connected) { pad = p; break; } }
      if (!pad) return;

      // Track which keys SHOULD be pressed this tick. Anything not in
      // this set that is currently held gets released.
      const want = new Set<Key>();
      for (const [idx, key] of BUTTON_MAP) {
        if (pad.buttons[idx] && pad.buttons[idx].pressed) want.add(key);
      }
      // Left analog stick → D-pad fallback (additive — left stick AND
      // D-pad both produce direction presses).
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (ax < -STICK_THRESHOLD) want.add(Key.LEFT);
      if (ax >  STICK_THRESHOLD) want.add(Key.RIGHT);
      if (ay < -STICK_THRESHOLD) want.add(Key.UP);
      if (ay >  STICK_THRESHOLD) want.add(Key.DOWN);

      // Apply diff.
      for (const k of want) press(k);
      for (const k of heldByPad) if (!want.has(k)) release(k);
    };
    raf = requestAnimationFrame(tick);

    const onConn = (e: GamepadEvent) => onConnected?.(e.gamepad.id);
    const onDisc = (e: GamepadEvent) => {
      // Release anything held when a controller drops out — otherwise
      // an in-game direction can get "stuck."
      for (const k of heldByPad) keypad.release(k);
      heldByPad.clear();
      onDisconnected?.(e.gamepad.id);
    };
    window.addEventListener('gamepadconnected', onConn);
    window.addEventListener('gamepaddisconnected', onDisc);

    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('gamepadconnected', onConn);
      window.removeEventListener('gamepaddisconnected', onDisc);
      for (const k of heldByPad) keypad.release(k);
      heldByPad.clear();
    };
  }, [keypad, onConnected, onDisconnected]);
}
