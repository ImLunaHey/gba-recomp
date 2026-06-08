import type { Ppu } from './ppu';

// Compose layers into the final RGBA frame line.
// Pixel encoding (32-bit):
//   bits 0..14   BGR555
//   bit 15       transparent
//   bits 16..17  layer id (0..3 BG, 4 OBJ, 5 backdrop)
//   bits 18..19  priority
//   bit 20       OBJ semi-transparent
//   bit 21       OBJ window

function bgr555ToRgba(bgr: number, out: Uint8ClampedArray, off: number): void {
  const r = bgr & 0x1F;
  const g = (bgr >> 5) & 0x1F;
  const b = (bgr >> 10) & 0x1F;
  out[off    ] = (r << 3) | (r >> 2);
  out[off + 1] = (g << 3) | (g >> 2);
  out[off + 2] = (b << 3) | (b >> 2);
  out[off + 3] = 0xFF;
}

function bgr555Blend(a: number, b: number, eva: number, evb: number): number {
  const ra = a & 0x1F, ga = (a >> 5) & 0x1F, ba = (a >> 10) & 0x1F;
  const rb = b & 0x1F, gb = (b >> 5) & 0x1F, bb = (b >> 10) & 0x1F;
  const r = Math.min(31, ((ra * eva) >> 4) + ((rb * evb) >> 4));
  const g = Math.min(31, ((ga * eva) >> 4) + ((gb * evb) >> 4));
  const bl = Math.min(31, ((ba * eva) >> 4) + ((bb * evb) >> 4));
  return (bl << 10) | (g << 5) | r;
}

export function compositeScanline(ppu: Ppu, y: number, backdrop: number): void {
  const out = ppu.frame;
  const offBase = y * 240 * 4;

  const bldcnt = ppu.bldcnt;
  const blendMode = (bldcnt >> 6) & 3;
  const top = bldcnt & 0x3F;
  const bot = (bldcnt >> 8) & 0x3F;
  const eva = Math.min(16, ppu.bldalpha & 0x1F);
  const evb = Math.min(16, (ppu.bldalpha >> 8) & 0x1F);
  const evy = Math.min(16, ppu.bldy & 0x1F);

  // Per-priority order: collect BG indices sorted by priority then index.
  // We compute on-the-fly for each pixel — fine for 240 wide.
  for (let x = 0; x < 240; x++) {
    let bestColor = backdrop;
    let bestPrio = 4;
    let bestLayer = 5;
    let bestSemi = 0;

    for (let b = 0; b < 4; b++) {
      const px = ppu.bgLine[b][x];
      if (px & 0x8000) continue;
      const prio = (px >> 18) & 3;
      if (prio < bestPrio || (prio === bestPrio && b < bestLayer)) {
        bestPrio = prio; bestColor = px & 0x7FFF; bestLayer = b; bestSemi = 0;
      }
    }
    const obj = ppu.objLine[x];
    if (!(obj & 0x8000)) {
      const prio = (obj >> 18) & 3;
      if (prio <= bestPrio) {
        bestPrio = prio; bestColor = obj & 0x7FFF; bestLayer = 4; bestSemi = (obj >> 20) & 1;
      }
    }

    // Find next-best for blending.
    let bot1Color = backdrop;
    let bot1Layer = 5;
    let bot1Prio = 4;
    for (let b = 0; b < 4; b++) {
      if (b === bestLayer) continue;
      const px = ppu.bgLine[b][x];
      if (px & 0x8000) continue;
      const prio = (px >> 18) & 3;
      if (prio < bot1Prio || (prio === bot1Prio && b < bot1Layer)) {
        bot1Prio = prio; bot1Color = px & 0x7FFF; bot1Layer = b;
      }
    }
    if (bestLayer !== 4 && !(obj & 0x8000)) {
      const prio = (obj >> 18) & 3;
      if (prio < bot1Prio || (prio === bot1Prio && 4 < bot1Layer)) {
        bot1Prio = prio; bot1Color = obj & 0x7FFF; bot1Layer = 4;
      }
    }

    let color = bestColor;
    const topMask = 1 << bestLayer;
    const botMask = 1 << bot1Layer;
    const topSet = (top & topMask) !== 0;
    const botSet = (bot & botMask) !== 0;

    if (bestSemi && botSet) {
      color = bgr555Blend(bestColor, bot1Color, eva, evb);
    } else if (blendMode === 1 && topSet && botSet) {
      color = bgr555Blend(bestColor, bot1Color, eva, evb);
    } else if (blendMode === 2 && topSet) {
      // Brighten toward white.
      const r = bestColor & 0x1F, g = (bestColor >> 5) & 0x1F, b = (bestColor >> 10) & 0x1F;
      const r2 = r + (((31 - r) * evy) >> 4);
      const g2 = g + (((31 - g) * evy) >> 4);
      const b2 = b + (((31 - b) * evy) >> 4);
      color = (b2 << 10) | (g2 << 5) | r2;
    } else if (blendMode === 3 && topSet) {
      // Darken toward black.
      const r = bestColor & 0x1F, g = (bestColor >> 5) & 0x1F, b = (bestColor >> 10) & 0x1F;
      const r2 = r - ((r * evy) >> 4);
      const g2 = g - ((g * evy) >> 4);
      const b2 = b - ((b * evy) >> 4);
      color = (b2 << 10) | (g2 << 5) | r2;
    }

    bgr555ToRgba(color, out, offBase + x * 4);
  }
}
