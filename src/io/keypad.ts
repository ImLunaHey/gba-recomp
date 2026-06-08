// GBA keypad — 10-bit register; 0 = pressed, 1 = released.
//  A  B  Sel Sta R  L  U  D  Rs Ls
// bit0 1  2   3  4  5  6  7  8  9

// NOT `const enum` so we can do reverse name lookups (`Key[k]`) — the
// gamepad/UI code uses string names ("A", "UP") for accessibility
// labels and remapping.
export enum Key {
  A = 0, B = 1, SELECT = 2, START = 3,
  RIGHT = 4, LEFT = 5, UP = 6, DOWN = 7,
  R = 8, L = 9,
}

export class Keypad {
  // Live bitmask of pressed keys (1 = pressed). We invert on read to match
  // the GBA's "released" polarity.
  pressed = 0;

  press(k: Key) { this.pressed |= 1 << k; }
  release(k: Key) { this.pressed &= ~(1 << k); }
  read16(): number { return (~this.pressed) & 0x3FF; }
}
