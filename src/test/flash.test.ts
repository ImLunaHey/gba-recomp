// Flash 128K chip-protocol tests. The chip must correctly probe as
// Macronix, accept the AGB SDK save sequence, persist data across
// bank-switches, and survive sector + chip erase. The save-flow has
// been the source of "saving... never finishes" bug reports.

import { describe, it, expect } from 'vitest';
import { Flash128K, FlashCmd } from '../memory/flash';

function unlock(flash: Flash128K) {
  flash.write(0x5555, 0xAA);
  flash.write(0x2AAA, 0x55);
}

describe('Flash: chip identification', () => {
  it('reports Macronix maker (0xC2) + device (0x09)', () => {
    const flash = new Flash128K();
    unlock(flash);
    flash.write(0x5555, 0x90);  // enter ID mode
    expect(flash.read(0)).toBe(0xC2);
    expect(flash.read(1)).toBe(0x09);
    // Exit ID.
    unlock(flash);
    flash.write(0x5555, 0xF0);
    flash.data[0] = 0x42;
    expect(flash.read(0)).toBe(0x42);
  });
  it('non-ID-mode read returns chip data, not IDs', () => {
    const flash = new Flash128K();
    flash.data[0] = 0xAB;
    expect(flash.read(0)).toBe(0xAB);
  });
});

describe('Flash: byte program', () => {
  it('write of 0xA0 then arbitrary address → programs that byte', () => {
    const flash = new Flash128K();
    unlock(flash);
    flash.write(0x5555, 0xA0);  // program command
    flash.write(0x1234, 0x77);
    expect(flash.data[0x1234]).toBe(0x77);
    // State returns to normal after program.
    expect(flash.state).toBe(FlashCmd.Normal);
  });
  it('multiple program operations each require their own unlock', () => {
    const flash = new Flash128K();
    unlock(flash); flash.write(0x5555, 0xA0); flash.write(0x100, 0x11);
    unlock(flash); flash.write(0x5555, 0xA0); flash.write(0x200, 0x22);
    expect(flash.data[0x100]).toBe(0x11);
    expect(flash.data[0x200]).toBe(0x22);
  });
  it('program triggers onChange notification', () => {
    const flash = new Flash128K();
    let calls = 0;
    flash.onChange = () => calls++;
    unlock(flash); flash.write(0x5555, 0xA0); flash.write(0x42, 0x55);
    expect(calls).toBe(1);
  });
});

describe('Flash: sector erase', () => {
  it('sector erase resets a 4KB sector to 0xFF', () => {
    const flash = new Flash128K();
    flash.data.fill(0x42);  // pollute
    // Erase sequence: AA 5555, 55 2AAA, 80 5555, AA 5555, 55 2AAA, 30 sectoraddr.
    unlock(flash); flash.write(0x5555, 0x80);
    unlock(flash); flash.write(0x1000, 0x30);
    for (let i = 0; i < 0x1000; i++) expect(flash.data[0x1000 + i]).toBe(0xFF);
    // Adjacent sector untouched.
    expect(flash.data[0x0000]).toBe(0x42);
    expect(flash.data[0x2000]).toBe(0x42);
  });
  it('chip erase clears entire 128 KB', () => {
    const flash = new Flash128K();
    flash.data.fill(0x55);
    unlock(flash); flash.write(0x5555, 0x80);
    unlock(flash); flash.write(0x5555, 0x10);  // chip erase
    for (let i = 0; i < flash.data.length; i++) expect(flash.data[i]).toBe(0xFF);
  });
});

describe('Flash: bank switching', () => {
  it('writing 1 to BankSelect sets bank 1', () => {
    const flash = new Flash128K();
    flash.data[0x10000] = 0xAB;  // bank 1, offset 0
    flash.data[0x00000] = 0xCD;  // bank 0, offset 0
    expect(flash.read(0)).toBe(0xCD);  // bank 0 active by default
    unlock(flash); flash.write(0x5555, 0xB0);  // BankSelect
    flash.write(0x0000, 0x01);
    expect(flash.read(0)).toBe(0xAB);  // bank 1 now visible
  });
  it('bank-1 program writes into the bank-1 region of the underlying array', () => {
    const flash = new Flash128K();
    unlock(flash); flash.write(0x5555, 0xB0); flash.write(0, 1);  // switch to bank 1
    unlock(flash); flash.write(0x5555, 0xA0); flash.write(0x100, 0x77);
    expect(flash.data[0x10100]).toBe(0x77);
    // Bank 0 untouched.
    expect(flash.data[0x00100]).toBe(0);
  });
});

describe('Flash: save round-trip via loadSave', () => {
  it('loadSave restores raw 128 KB', () => {
    const flash = new Flash128K();
    const blob = new Uint8Array(0x20000);
    for (let i = 0; i < blob.length; i++) blob[i] = (i * 31) & 0xFF;
    flash.loadSave(blob);
    for (let i = 0; i < blob.length; i++) expect(flash.data[i]).toBe(blob[i]);
  });
  it('loadSave with shorter buffer pads with 0xFF', () => {
    const flash = new Flash128K();
    flash.loadSave(new Uint8Array([1, 2, 3, 4]));
    expect(flash.data[0]).toBe(1);
    expect(flash.data[3]).toBe(4);
    expect(flash.data[0x1FFFF]).toBe(0xFF);
  });
});
