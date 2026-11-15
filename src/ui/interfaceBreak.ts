/**
 * Interface Breaks: short-lived marks over the whole interface (e.g. bullet
 * holes, cracks) that a Manipulation's editor sets off. They're drawn in a
 * layer above everything that ignores the pointer, so the interface stays
 * usable underneath, and they outlive the editor that set them off.
 */
export interface InterfaceBreak {
  /** How long it stays once drawn, before it starts repairing, in ms. */
  holdMs: number;
  /** Draw the break into its own container, which covers the viewport. */
  draw(container: HTMLElement): void;
  /**
   * Make it go away; may add temporary elements to the container. The
   * container is removed once this resolves. Default: fade out.
   */
  repair?(container: HTMLElement): Promise<void>;
}

/** How long the default repair fades out, in ms. */
export const REPAIR_FADE_MS = 300;

let layer: HTMLElement | null = null;

function breakLayer(): HTMLElement {
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'interface-breaks';
    document.body.append(layer);
  }
  return layer;
}

export function breakInterface(b: InterfaceBreak) {
  const container = document.createElement('div');
  container.className = 'interface-break';
  breakLayer().append(container);
  b.draw(container);
  window.setTimeout(async () => {
    try {
      await (b.repair ?? fadeOut)(container);
    } finally {
      container.remove();
    }
  }, b.holdMs);
}

async function fadeOut(container: HTMLElement) {
  await container.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: REPAIR_FADE_MS,
    easing: 'ease-in',
    fill: 'forwards',
  }).finished;
}

const SVG = 'http://www.w3.org/2000/svg';
let clipIds = 0;

/** An SVG `transform` attribute for a DOMMatrix. */
export function matrixAttr(m: DOMMatrixReadOnly): string {
  return `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
}

/**
 * A group in `container` to draw into in a Canvas's image px, placed on screen
 * by `toScreen` (image px → viewport px). With `except` (in image px), nothing
 * drawn inside that rectangle shows, e.g. to leave the image itself alone.
 */
export function imageGroup(
  container: HTMLElement,
  toScreen: DOMMatrixReadOnly,
  except?: { x: number; y: number; width: number; height: number },
): SVGGElement {
  const svg = document.createElementNS(SVG, 'svg');
  const g = document.createElementNS(SVG, 'g');
  g.setAttribute('transform', matrixAttr(toScreen));
  if (except) {
    const id = `interface-break-clip-${++clipIds}`;
    const clip = document.createElementNS(SVG, 'clipPath');
    clip.id = id;
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    const path = document.createElementNS(SVG, 'path');
    const { x, y, width: w, height: h } = except;
    const far = 1e6;
    path.setAttribute(
      'd',
      `M${-far} ${-far}H${far}V${far}H${-far}Z M${x} ${y}h${w}v${h}h${-w}Z`,
    );
    path.setAttribute('clip-rule', 'evenodd');
    clip.append(path);
    g.append(clip);
    const inner = document.createElementNS(SVG, 'g');
    inner.setAttribute('clip-path', `url(#${id})`);
    g.append(inner);
    svg.append(g);
    container.append(svg);
    return inner;
  }
  svg.append(g);
  container.append(svg);
  return g;
}

/** An SVG path element with the given `d`, filled with the paper color. */
export function paperPath(d: string): SVGPathElement {
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  path.style.fill = 'var(--paper)';
  return path;
}
