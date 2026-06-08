import { describe, it, expect } from 'vitest';
import { parseCheat, applyCheats } from '../io/cheats';

class MockBus {
  mem = new Map<number, number>();
  read8(a: number) { return this.mem.get(a) ?? 0; }
  read16(a: number) { return (this.read8(a) | (this.read8(a + 1) << 8)) & 0xFFFF; }
  write8(a: number, v: number) { this.mem.set(a, v & 0xFF); }
  write16(a: number, v: number) { this.write8(a, v); this.write8(a + 1, (v >> 8) & 0xFF); }
  write32(a: number, v: number) { this.write16(a, v); this.write16(a + 2, (v >>> 16) & 0xFFFF); }
}

describe('Cheat parser', () => {
  it('parses GS write8 (opcode 0x0)', () => {
    const [line] = parseCheat('02001234 000000FF');
    expect(line.type).toBe('write8');
    expect(line.address).toBe(0x02001234);
    expect(line.value).toBe(0xFF);
  });
  it('parses GS write16 (opcode 0x1)', () => {
    const [line] = parseCheat('12001234 0000ABCD');
    expect(line.type).toBe('write16');
    expect(line.address).toBe(0x02001234);
    expect(line.value).toBe(0xABCD);
  });
  it('parses GS write32 (opcode 0x2)', () => {
    const [line] = parseCheat('22001234 DEADBEEF');
    expect(line.type).toBe('write32');
    expect(line.value).toBe(0xDEADBEEF);
  });
  it('parses CodeBreaker write16 (opcode 0x8, 12-hex form)', () => {
    // The classic Pokemon FireRed / Ruby max-money code shape:
    // 82025BCC 423F  →  write 0x423F at 0x02025BCC (EWRAM)
    const [line] = parseCheat('82025BCC 423F');
    expect(line.type).toBe('write16');
    expect(line.address).toBe(0x02025BCC);
    expect(line.value).toBe(0x423F);
  });
  it('parses conditional eq16 (opcode 0xD)', () => {
    const [line] = parseCheat('D2001234 0000AAAA');
    expect(line.type).toBe('eq16');
    expect(line.address).toBe(0x02001234);
    expect(line.value).toBe(0xAAAA);
  });
  it('strips spaces and accepts multiple lines', () => {
    const lines = parseCheat('12 00 12 34 0000 AAAA\n12001236 0000BBBB');
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe('write16');
    expect(lines[1].type).toBe('write16');
  });
  it('ignores comment lines', () => {
    const lines = parseCheat('# this is a comment\n12001234 0000ABCD');
    expect(lines).toHaveLength(1);
  });
  it('returns unsupported for unknown opcodes', () => {
    const [line] = parseCheat('F0001234 00000000');
    expect(line.type).toBe('unsupported');
  });
  it('returns unsupported for odd hex-length inputs', () => {
    const [line] = parseCheat('12345 67');
    expect(line.type).toBe('unsupported');
  });
});

describe('Cheat application', () => {
  it('writes a byte for a simple GS write8 cheat', () => {
    const bus = new MockBus();
    applyCheats(bus, [{ name: 'hp', code: '02001234 000000FF', enabled: true }]);
    expect(bus.read8(0x02001234)).toBe(0xFF);
  });
  it('writes a halfword for a CodeBreaker-style cheat', () => {
    const bus = new MockBus();
    applyCheats(bus, [{ name: 'money', code: '82025BCC 423F', enabled: true }]);
    expect(bus.read16(0x02025BCC)).toBe(0x423F);
  });
  it('skips disabled cheats', () => {
    const bus = new MockBus();
    applyCheats(bus, [{ name: 'hp', code: '02001234 000000FF', enabled: false }]);
    expect(bus.read8(0x02001234)).toBe(0);
  });
  it('conditional eq16 gates the next line (match path)', () => {
    const bus = new MockBus();
    bus.write16(0x02010000, 0x1234);
    bus.write16(0x02010002, 0x9999);
    applyCheats(bus, [{
      name: 'cond',
      code: 'D2010000 00001234\n12010002 0000AAAA',
      enabled: true,
    }]);
    expect(bus.read16(0x02010002)).toBe(0xAAAA);
  });
  it('conditional eq16 SKIPS write when not equal', () => {
    const bus = new MockBus();
    bus.write16(0x02010000, 0x0000);  // does NOT match
    bus.write16(0x02010002, 0x9999);
    applyCheats(bus, [{
      name: 'cond',
      code: 'D2010000 00001234\n12010002 0000AAAA',
      enabled: true,
    }]);
    expect(bus.read16(0x02010002)).toBe(0x9999); // unchanged
  });
});
