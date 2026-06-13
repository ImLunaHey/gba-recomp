# Expo / React-Native port plan

Goal: run gba-recomp on **iOS, Android, and web** from one Expo codebase.

This branch (`expo`) holds the migration. Status: **groundwork** — the
emulator core is confirmed portable and made import-safe; the RN shell
is the remaining work (it's large, and needs an Expo toolchain to build
and verify on device/simulator).

## What's reusable as-is

The emulator **core** is ~6,000 LOC of pure TypeScript with no UI
dependency and almost no browser API:

- `src/cpu/`, `src/ppu/`, `src/io/`, `src/memory/`, `src/bios/`,
  `src/emulator.ts`, `src/savestate.ts` — fully portable.
- Verified: zero imports from `src/ui`; the only browser touchpoints are
  the JIT's `WebAssembly` and one `window.location` (now guarded).

→ Lift this into a shared module (e.g. `packages/core/`) consumed by both
the web app and the Expo app. No logic changes needed.

## Platform shims (the actual work)

Each browser API the *shell* relies on needs an RN equivalent:

| Concern | Web (today) | React Native |
|---|---|---|
| **JIT** | `WebAssembly` (`src/recomp`) | Hermes has no WASM → set `recomp.enabled = false`; the pure-TS interpreter runs everywhere. Keep the JIT on Expo **web**. |
| **Framebuffer** | `<canvas>` + `putImageData` | upload `emu.ppu.frame` (RGBA) as a texture each frame via **expo-gl** (or react-native-skia `Image`); draw a fullscreen quad, nearest-neighbour. |
| **Audio** | Web Audio (`AudioSink`) | hardest part. Stream 32 kHz PCM via a native module / `expo-av` buffer queue, or skip audio in v1. |
| **Input** | Gamepad API + keyboard + on-screen | on-screen touch pad (RN gestures) is the baseline; hardware pads via platform APIs later. |
| **ROM/save storage** | IndexedDB (`romStore`, `stateStore`, `coverStore`) | `expo-file-system` for ROM/state blobs + `expo-sqlite`/`AsyncStorage` for the index. Same async shape, swap the backend. |
| **Settings** | `localStorage` (`usePersistedState`) | `AsyncStorage` — keep the hook API, change the backend. |
| **Routing** | react-router-dom | `expo-router` / react-navigation. |
| **UI components** | React DOM + Tailwind | React Native views + **NativeWind** (Tailwind for RN) to reuse class names where possible; the panels/library/player are a full re-layout. |
| **Cheat DB** | `fetch('/cheats-gba.json')` | bundle the JSON as an asset (`require`) or fetch from the deployed origin. |

## Phased plan

1. **Monorepo split** — move the core to `packages/core`, point the
   existing web app at it (no behaviour change), add an `apps/mobile`
   Expo app. Keeps web shipping while mobile is built.
2. **Boot + render** — Expo screen that constructs `Emulator`
   (interpreter, JIT off), runs `runFrame()` on a loop, and renders the
   framebuffer via expo-gl. Proves the core on device. (web first — easiest.)
3. **Storage** — port romStore/stateStore/coverStore to expo-file-system
   + a key/value index; ROM import via `expo-document-picker`.
4. **Input** — on-screen gamepad (reuse the `Keypad` + layout), touch.
5. **Audio** — PCM streaming (the risk; spike early to de-risk).
6. **Feature parity** — save states, settings, rewind, cheats, etc.,
   reusing the core hooks behind RN UI.
7. **Polish** — per-platform (haptics via expo-haptics, etc.).

## Notes / risks

- **Audio on RN** is the biggest unknown — Web Audio's sample-accurate
  scheduling has no direct RN analogue. Plan a spike in phase 5.
- **Perf**: the interpreter (no JIT) is slower; fine on modern phones for
  many games, but the JIT-on-web path keeps web fast.
- Keep the core's public surface stable so both shells share it verbatim.
