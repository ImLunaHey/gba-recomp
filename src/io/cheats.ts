// Cheat code support. Accepts the most common GBA cheat-code shapes
// from cheat databases (GameShark v3 / CodeBreaker / Action Replay
// decrypted form, all variants on the 8-byte "address+type | value"
// layout) and applies them every frame after the game's done running.
//
// The wire format on every cheat database I've looked at:
//   "XXXXXXXX YYYYYYYY"
// 8 hex chars + space + 8 hex chars. The TOP NIBBLE of the first word
// selects the operation. Multiple codes per cheat are separated by
// newlines or '+'.

export interface Cheat {
  name: string;
  code: string;     // raw user input (can be multi-line)
  enabled: boolean;
}

export interface ParsedLine {
  type: 'write8' | 'write16' | 'write32' | 'eq16' | 'eq8' | 'unsupported';
  address: number;
  value: number;
}

const HEX = /^[0-9a-fA-F]+$/;

function parseHex(s: string): number {
  return HEX.test(s) ? parseInt(s, 16) >>> 0 : NaN;
}

// Parse one 16-hex-char line into a ParsedLine. Returns null for
// blank lines or comments; the type field is "unsupported" when the
// opcode isn't one of the supported simple-write / conditional kinds.
function parseLine(raw: string): ParsedLine | null {
  const clean = raw.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length === 0) return null;
  // We accept both wire formats:
  //   - 16 hex chars: GameShark v3 / Action Replay   (8 addr + 8 value)
  //   - 12 hex chars: CodeBreaker / Pokemon-style    (8 addr + 4 value)
  let a: number;
  let b: number;
  if (clean.length === 16) {
    a = parseHex(clean.slice(0, 8));
    b = parseHex(clean.slice(8, 16));
  } else if (clean.length === 12) {
    a = parseHex(clean.slice(0, 8));
    b = parseHex(clean.slice(8, 12));
  } else {
    return { type: 'unsupported', address: 0, value: 0 };
  }
  if (isNaN(a) || isNaN(b)) return { type: 'unsupported', address: 0, value: 0 };
  // Top nibble of word 1 = opcode. Bottom 24 bits = address (high byte
  // implicit 0x02 = EWRAM for most opcodes, 0x03 = IWRAM via 0x3..., or
  // explicit 0x08 = ROM for read-only conditions).
  // Hybrid decoder that handles GameShark v3 / CodeBreaker / Action
  // Replay all in one. Top NIBBLE is the opcode family; the full
  // bottom 28 bits are the address, which is enough range to reach
  // any GBA memory region. (CB-style codes like 82025BCC encode the
  // region prefix into the second nibble — 0x8 = "write16" opcode,
  // and the rest of the word IS the address starting with 0x02xxxxxx
  // for EWRAM. This decoder treats them uniformly.)
  const op = (a >>> 28) & 0xF;
  const addr = a & 0x0FFFFFFF;
  switch (op) {
    case 0x0: return { type: 'write8',  address: addr, value: b & 0xFF };
    case 0x1: return { type: 'write16', address: addr, value: b & 0xFFFF };
    case 0x2: return { type: 'write32', address: addr, value: b >>> 0 };
    case 0x3: return { type: 'write8',  address: addr, value: b & 0xFF };
    case 0x4: return { type: 'write32', address: addr, value: b >>> 0 };
    case 0x8: return { type: 'write16', address: addr, value: b & 0xFFFF };
    case 0xD: return { type: 'eq16',    address: addr, value: b & 0xFFFF };
    case 0xE: return { type: 'eq8',     address: addr, value: b & 0xFF };
    default:  return { type: 'unsupported', address: addr, value: b };
  }
}

export function parseCheat(code: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const raw of code.split(/[\n+]/)) {
    if (raw.trim().startsWith('#') || raw.trim().startsWith('//')) continue;
    const parsed = parseLine(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface BusLike {
  read8: (a: number) => number;
  read16: (a: number) => number;
  write8: (a: number, v: number) => void;
  write16: (a: number, v: number) => void;
  write32: (a: number, v: number) => void;
}

// Apply all enabled cheats once. Conditional opcodes (eq8/eq16) gate
// the very next line, mirroring the GS v3 "if this, then poke that"
// pattern that 99% of code-database entries use.
export function applyCheats(bus: BusLike, cheats: Cheat[]): void {
  for (const cheat of cheats) {
    if (!cheat.enabled || !cheat.code) continue;
    const lines = parseCheat(cheat.code);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.type === 'eq16') {
        if (bus.read16(line.address) !== line.value) i++;
        continue;
      }
      if (line.type === 'eq8') {
        if (bus.read8(line.address) !== line.value) i++;
        continue;
      }
      if (line.type === 'write8')  bus.write8(line.address, line.value);
      if (line.type === 'write16') bus.write16(line.address, line.value);
      if (line.type === 'write32') bus.write32(line.address, line.value);
    }
  }
}
