export class CanvasView {
  ctx: CanvasRenderingContext2D;
  imageData: ImageData;

  constructor(public canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.imageData = ctx.createImageData(240, 160);
  }

  blit(frame: Uint8ClampedArray): void {
    this.imageData.data.set(frame);
    this.ctx.putImageData(this.imageData, 0, 0);
  }
}
