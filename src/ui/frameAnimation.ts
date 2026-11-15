/**
 * A looping frame-by-frame animation from a list of image URLs, as a DOM
 * element (so it works outside React, e.g. in Interface Breaks). All frames
 * are stacked and only the current one shows, so switching never flickers
 * while an image decodes.
 */
export class FrameAnimation {
  readonly element: HTMLElement;
  private timer: number | undefined;

  constructor(private fps: number) {
    this.element = document.createElement('div');
    this.element.className = 'frame-animation';
  }

  /** Loop these frames from the first, replacing whatever was playing. */
  play(frames: readonly string[]) {
    this.stop();
    const imgs = frames.map((src) => {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.draggable = false;
      return img;
    });
    this.element.replaceChildren(...imgs);
    let i = 0;
    const show = () => imgs.forEach((img, j) => (img.style.visibility = j === i ? 'visible' : 'hidden'));
    show();
    if (imgs.length > 1) {
      this.timer = window.setInterval(() => {
        i = (i + 1) % imgs.length;
        show();
      }, 1000 / this.fps);
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Start loading images ahead, so the first time they play they're ready. */
export function preloadFrames(...lists: (readonly string[])[]) {
  for (const list of lists) for (const src of list) new Image().src = src;
}
