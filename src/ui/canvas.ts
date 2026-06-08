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

  // Overlay text on top of the blitted frame using the 2D context.
  // Used to expose live boot diagnostics (PC, IRQ, frame count) on the
  // canvas while the game's own VRAM render hasn't kicked in yet.
  overlay(lines: string[]): void {
    this.ctx.save();
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    this.ctx.fillRect(2, 2, 236, lines.length * 11 + 6);
    this.ctx.font = '8px ui-monospace, SF Mono, Menlo, monospace';
    this.ctx.fillStyle = '#9be7ff';
    this.ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      this.ctx.fillText(lines[i], 6, 6 + i * 11);
    }
    this.ctx.restore();
  }
}
