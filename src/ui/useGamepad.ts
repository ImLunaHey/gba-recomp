import { useEffect } from 'react';
import { Key, Keypad } from '../io/keypad';

// W3C Standard Gamepad mapping (when navigator reports
// `pad.mapping === "standard"`) — button 0 is the BOTTOM of the right
// cluster, which is Cross on a PS5 DualSense.
const STANDARD_MAP: Array<[number, Key]> = [
  [0,  Key.A],       // Cross  → GBA A
  [1,  Key.B],       // Circle → GBA B
  [4,  Key.L],       // L1
  [5,  Key.R],       // R1
  [8,  Key.SELECT],  // Share / View
  [9,  Key.START],   // Options / Menu
  [12, Key.UP],
  [13, Key.DOWN],
  [14, Key.LEFT],
  [15, Key.RIGHT],
];

// PS5 DualSense on macOS Safari (and some Bluetooth-driver combinations
// on Chrome) reports `mapping: ""` and puts the buttons in Sony's native
// order: Square=0, Cross=1, Circle=2, Triangle=3. This matters because
// Square is the LEFT button of the right cluster; if we used the
// "standard" mapping anyway, pressing X (Cross, the natural "confirm"
// button) would do nothing and pressing Square would fire the A action.
const SONY_NONSTANDARD_MAP: Array<[number, Key]> = [
  [1,  Key.A],       // Cross    → GBA A
  [2,  Key.B],       // Circle   → GBA B
  [6,  Key.L],       // L1
  [7,  Key.R],       // R1
  [8,  Key.SELECT],
  [9,  Key.START],
  [14, Key.UP],
  [15, Key.DOWN],
  [16, Key.LEFT],
  [17, Key.RIGHT],
];

const STICK_THRESHOLD = 0.5;

interface UseGamepadOptions {
  keypad: Keypad;
  onConnected?: (name: string) => void;
  onDisconnected?: (name: string) => void;
  // Whether to also synthesize D-pad input from the left analog stick.
  // Off by default — many controllers report D-pad twice (once via the
  // dedicated buttons, once via the stick) and overlapping inputs feel
  // wrong if you're holding D-pad while resting your thumb on the stick.
  stickAsDpad?: boolean;
}

export function useGamepad({ keypad, onConnected, onDisconnected, stickAsDpad = false }: UseGamepadOptions) {
  useEffect(() => {
    const heldByPad = new Set<Key>();
    let raf = 0;
    let stop = false;
    let mapping: Array<[number, Key]> = STANDARD_MAP;

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

      const want = new Set<Key>();
      for (const [idx, key] of mapping) {
        if (pad.buttons[idx] && pad.buttons[idx].pressed) want.add(key);
      }
      if (stickAsDpad) {
        const ax = pad.axes[0] ?? 0;
        const ay = pad.axes[1] ?? 0;
        if (ax < -STICK_THRESHOLD) want.add(Key.LEFT);
        if (ax >  STICK_THRESHOLD) want.add(Key.RIGHT);
        if (ay < -STICK_THRESHOLD) want.add(Key.UP);
        if (ay >  STICK_THRESHOLD) want.add(Key.DOWN);
      }

      for (const k of want) press(k);
      for (const k of heldByPad) if (!want.has(k)) release(k);
    };
    raf = requestAnimationFrame(tick);

    const onConn = (e: GamepadEvent) => {
      // Pick the layout based on what the browser reports. "standard"
      // is the W3C order (Cross = 0); anything else, assume Sony's
      // native order (Square = 0, Cross = 1).
      mapping = e.gamepad.mapping === 'standard' ? STANDARD_MAP : SONY_NONSTANDARD_MAP;
      onConnected?.(`${e.gamepad.id} [${e.gamepad.mapping || 'non-standard'}]`);
    };
    const onDisc = (e: GamepadEvent) => {
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
