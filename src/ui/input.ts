import { Key, Keypad } from '../io/keypad';

const MAP: Record<string, Key> = {
  ArrowUp: Key.UP,
  ArrowDown: Key.DOWN,
  ArrowLeft: Key.LEFT,
  ArrowRight: Key.RIGHT,
  z: Key.A,
  Z: Key.A,
  x: Key.B,
  X: Key.B,
  a: Key.L,
  A: Key.L,
  s: Key.R,
  S: Key.R,
  Enter: Key.START,
  Shift: Key.SELECT,
};

export function bindKeys(keypad: Keypad): void {
  window.addEventListener('keydown', (e) => {
    const k = MAP[e.key];
    if (k !== undefined) { keypad.press(k); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    const k = MAP[e.key];
    if (k !== undefined) { keypad.release(k); e.preventDefault(); }
  });
}
