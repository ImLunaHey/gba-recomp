# gba-recomp

A Game Boy Advance emulator that runs entirely in the browser. Cycle-batched ARM7TDMI interpreter (ARM + THUMB), full PPU (every BG mode, sprites with rotation/scaling, affine, windows, mosaic, blending), DMA, timers, IRQs, PSG + DirectSound audio in stereo, SIO link cable over WebRTC, S-3511A RTC, and autodetected SRAM / Flash / EEPROM saves on an HLE BIOS. On top of the interpreter sits a **WebAssembly recompiler (JIT)**, on by default, that compiles hot basic blocks to WASM. React + Tailwind UI with a ROM library, save states, gamepad/keyboard support, and an installable PWA shell.

No prebuilt BIOS, no off-the-shelf cores — the whole stack is written from scratch in TypeScript.

## Status

| Game | Boots | Plays | Sound | Notes |
|---|---|---|---|---|
| Pokemon FireRed | ✓ | ✓ | ✓ | Oak intro + name entry verified |
| Pokemon Emerald | ✓ | ✓ | ✓ | |
| Pokemon Ruby | ✓ | ✓ | ✓ | "Battery has run dry" fixed |
| Garfield: Search for Pooky | ✓ | ✓ | ✓ | Language select renders |
| Crash Bandicoot | ✓ | ✓ | ✓ | Title intro + Earth flyby |

The vitest suite gates the CPU, BIOS HLE, PPU compositor + sprites + BG + window mask, DMA channels, timers, IRQ, RTC bit-bang protocol, save back-ends, and LZ77/Huffman decompression. The recompiler is additionally validated by **register-by-register lockstep against the interpreter** across many ROMs — billions of instructions with zero divergence.

## Recompiler (JIT)

A WebAssembly basic-block recompiler runs **on by default**. It tracks hot PCs, and once one crosses a threshold it scans forward emitting WASM until it hits a branch or an unsupported instruction, then instantiates the module once and reuses it. Register + CPSR state lives in shared WASM linear memory so a typical ALU op is a couple of `i32.load`/`store`s rather than import callbacks.

Coverage:

- **Every THUMB format** (1–16, 18, 19) except `SWI`.
- **Nearly the entire ARM instruction set** — data-processing (any condition code, all operand-2 forms incl. register-specified shifts), branches (B/BL/BX), loads/stores (LDR/STR + half/byte variants with ARM7TDMI unaligned semantics), block transfer (LDM/STM), and multiply including the 64-bit longs (UMULL/SMULL/UMLAL/SMLAL).
- Only `SWI`, `MRS`/`MSR`, `SWP`, and empty-register-list LDM/STM fall back to the interpreter.

Blocks compiled out of writable RAM (EWRAM/IWRAM) snapshot their halfwords and are re-validated on every dispatch, so self-modified code (e.g. routines copied onto the IWRAM stack) never runs stale. Toggle the JIT and watch live block/instruction stats in the Debug panel's **Advanced** tab.

## Quick start

```bash
git clone git@github.com:ImLunaHey/gba-recomp.git
cd gba-recomp
npm install
npm run dev
```

Open the URL Vite prints. For a stable local URL, `npm run dev:portless` serves `https://gba-recomp.localhost` via [portless](https://www.npmjs.com/package/portless).

Open the app, then add a ROM through the library — drag any `.gba` file in, or use the picker. ROMs are stored in your browser's IndexedDB and **never leave the browser**; in-cart saves and save states persist locally too.

## ROM library

The home page is a library: a searchable, sortable grid of your ROMs with cover art fetched from Hasheous / IGDB / LibRetro, a **"Continue playing"** hero for your most recent game, and a per-ROM details page. Click a card to jump to `/play/:romId`. Everything is local-first — the only network calls are for cover art lookups.

## Controls

| GBA | Keyboard | PS5 / DualShock | Xbox-style |
|---|---|---|---|
| A | Z | ✕ Cross | A |
| B | X | ○ Circle | B |
| L / R | A / S | L1 / R1 | LB / RB |
| Start | Enter | Options | Menu |
| Select | Shift | Share | View |
| D-pad | Arrow keys | D-pad | D-pad |

Player shortcuts:

| Key | Action |
|---|---|
| Tab | Fast-forward (hold) |
| `.` | Frame-step |
| F2 / F4 | Quick save / quick load |
| Backspace | Rewind (when enabled in Settings) |

Input works from on-screen buttons, the keyboard, and hardware gamepads — **multiple gamepads at once**, with active-controller switching. The on-screen buttons are clickable / touchable and light up for any input source. Keyboard bindings are remappable, and there's turbo/autofire per button. A controller hotkey (**Start+Select**, or the **PS5 touchpad**) opens a controller-navigable menu so you can drive the whole UI from the pad. The HID hat-axis encoding (PS5 on macOS Safari) is auto-decoded.

## Save states & in-cart saves

In-cart saves are automatic and persist locally, keyed by the game's code. The save back-end is **autodetected** from the ROM's AGB signature — 32 KB SRAM, 64 KB / 128 KB Flash, or 512 B / 8 KB serial EEPROM — defaulting to Flash 128 KB. Export / import the raw `.sav` blob from the player.

Save states are separate: snapshot the full emulator state into numbered **slots**, each with a thumbnail. Quick save / load is on F2 / F4, plus auto-save and auto-resume so you pick up where you left off.

## Settings & extras

- **Audio** — volume, mute.
- **Speed** — emulation-speed multipliers, plus fast-forward (Tab) and frame-step (`.`).
- **Video** — pixel-perfect vs. bilinear scaling, GBA LCD color correction, and an LCD-grid overlay.
- **Rewind** — hold Backspace to scrub backwards when enabled.
- **Haptics** — gamepad/touch rumble feedback.
- **Cheats** — GameShark / Action Replay style codes via the Cheats panel.
- **Link cable** — SIO over WebRTC for local multiplayer / trading via the Link panel.
- **Screenshots** of the current frame.
- **PWA** — installable, with an offline app shell.

The UI is a themed dark shell with shared modals, toasts, and mobile bottom-sheets.

## Running headless

```bash
# Boot a ROM for N frames and dump CPU/PPU stats
npm run boot -- public/firered.gba 60

# Press A every 60 frames (useful for getting past intros)
PRESS_A_EVERY=60 npm run boot -- public/firered.gba 600

# Dump active OAM after frame N
DUMP_SPRITE_FRAME=300 npm run boot -- public/firered.gba 0
```

ROMs aren't shipped — put `.gba` files in `public/` and they'll be reachable. `public/*.gba` is gitignored.

## Architecture

```
src/
  cpu/            ARM7TDMI interpreter
    state.ts        16 registers, banked SP/LR per mode, CPSR/SPSR
    arm.ts          ARM-mode dispatch + decode (32-bit insns)
    thumb.ts        THUMB-mode dispatch + decode (16-bit insns)
    shifter.ts      Barrel shifter
    cpu.ts          Top-level step(), IRQ handling, exception entry,
                    BIOS stub installation
  ppu/
    ppu.ts          Mode dispatch, scanline timing, VBlank/HBlank/VCount IRQs
    modes_text.ts   Text-mode BG renderer (4bpp and 8bpp)
    modes_affine.ts Affine BG renderer (mode 1 BG2, mode 2 BG2/3)
    modes_bitmap.ts Modes 3/4/5 bitmap renderers
    sprites.ts      OAM scan + sprite render (incl. affine + double-size)
    composite.ts    Per-pixel BG/OBJ priority + windowing + mosaic + blending
  io/
    io.ts           IO port routing
    irq.ts          IE/IF/IME
    dma.ts          4 channels (immediate / VBlank / HBlank / special)
    timers.ts       4 timers with prescalers + count-up cascade
    sound.ts        PSG channels 1-4 + DirectSound A/B FIFOs, stereo mix
    sio.ts          Serial IO (normal / multiplayer modes)
    sio-signal.ts   WebRTC signalling for the link cable
    cheats.ts       GameShark / Action Replay code engine
    keypad.ts       KEYINPUT bitmask
  memory/
    bus.ts          Region routing (EWRAM/IWRAM/PRAM/VRAM/OAM/ROM/save)
    flash.ts        Macronix / Atmel Flash chip emulation (64/128 KB)
    sram.ts         32 KB battery-backed SRAM
    eeprom.ts       512 B / 8 KB serial EEPROM
    saveDetect.ts   Save-type autodetect from the AGB signature
    rtc.ts          Seiko S-3511A RTC bit-bang protocol
    regions.ts      Memory map constants
  bios/
    hle.ts          BIOS SWI high-level emulation
  recomp/           THUMB+ARM → WASM basic-block recompiler (enabled by
    compiler.ts       default; SWI/MRS/MSR/SWP fall back to the interpreter)
    wasm-emit.ts      WASM module builder
  savestate.ts      Full emulator state snapshot / restore
  ui/               React + Tailwind UI (LibraryPage, PlayerPage, Screen,
                    Gamepad, ControllerPanel, RomLibrary, SaveStatesPanel,
                    SettingsPanel, CheatsPanel, LinkPanel, DebugPanel,
                    audio sink, gamepad polling)
  emulator.ts       Composes all the above; runFrame() advances the CPU
                    one frame's worth of cycles, the PPU/Timer/Sound, and
                    returns stats
  worker.ts         Cloudflare Worker entry (serves the built app)
```

## Build + test

```bash
npm run test        # vitest
npm run test:watch  # interactive
npm run lint        # oxlint
npm run build       # tsc && vite build → dist/
npm run preview     # build, then serve via wrangler dev
npm run deploy      # build + wrangler deploy (Cloudflare)
```

Tests that need a real ROM are **skipped when the ROM file is absent** (ROMs are gitignored), so CI passes without shipping any game.

## Bugs / requests

[github.com/ImLunaHey/gba-recomp/issues](https://github.com/ImLunaHey/gba-recomp/issues) — please include the game, what you were doing, and (if a visual bug) a screenshot. If you can reproduce it from a fresh boot with a specific sequence of inputs, even better.

## Tech

- TypeScript everywhere
- React 19 + Tailwind 4 for UI, React Router for navigation
- TanStack Query (with persistence) for cover-art fetching/caching
- WebAssembly for the recompiler
- Vite for the dev server + bundler
- Vitest for tests, Oxlint for lint
- Cloudflare Workers + Wrangler for deploy
- IndexedDB for ROM storage, local persistence for saves + save states
- Web Audio API for sound, Web Gamepad API for controllers, Pointer events for touch + mouse
- WebRTC for the link cable
- PWA (web manifest + service worker) for install + offline shell

The core emulator (`cpu/`, `ppu/`, `io/`, `memory/`, `bios/`, `recomp/`) is pure TypeScript with TypedArrays — no DOM, no browser APIs beyond `WebAssembly`. It can be reused under a different UI shell.
