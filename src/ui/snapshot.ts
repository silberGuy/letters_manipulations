import { domToCanvas } from 'modern-screenshot';
import { useAppElement } from '../store/appElement';

/**
 * A picture of the interface at one moment, for Interface Breaks that move
 * its pixels (e.g. a Tear pushing the interface's ink aside).
 */
export interface InterfaceSnapshot {
  pixels: ImageData;
  /** Where the picture's top-left is, in viewport px. */
  x: number;
  y: number;
  /** Picture px per viewport px. */
  scale: number;
}

/**
 * Take a snapshot of the interface. The browser can't screenshot a page, so
 * this redraws the app's DOM into an image (via SVG foreignObject): it takes
 * a moment, and some details (e.g. native form controls) may come out a
 * little off. Null if there's nothing to capture or it fails.
 */
export async function snapshotInterface(): Promise<InterfaceSnapshot | null> {
  const app = useAppElement.getState().appElement;
  if (!app) return null;
  const rect = app.getBoundingClientRect();
  const scale = Math.min(2, window.devicePixelRatio || 1);
  try {
    const canvas = await domToCanvas(app, {
      scale,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      onCloneNode: (clone) => {
        if (clone instanceof HTMLElement) restorePseudoStyles(clone);
      },
    });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    return {
      pixels: ctx.getImageData(0, 0, canvas.width, canvas.height),
      x: rect.left,
      y: rect.top,
      scale: canvas.width / rect.width,
    };
  } catch (e) {
    console.warn('Interface snapshot failed', e);
    return null;
  }
}

/**
 * Pseudo-elements the snapshot doesn't copy styles for (it only copies
 * ::before, ::after, ::placeholder and scrollbars), e.g. a range's thumb and
 * track: without this they'd show the browser's default look.
 */
const UNCOPIED_PSEUDO = /::-(webkit|moz)-(?!scrollbar)/;

/**
 * Give the clone the page's own rules for those pseudo-elements, and the
 * custom properties they read. The clone keeps its classes, so they match.
 */
function restorePseudoStyles(clone: HTMLElement) {
  const rules: string[] = [];
  const collect = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSStyleRule) {
        if (UNCOPIED_PSEUDO.test(rule.selectorText)) rules.push(rule.cssText);
      } else if (rule instanceof CSSGroupingRule) {
        collect(rule.cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collect(sheet.cssRules);
    } catch {
      // A cross-origin sheet (e.g. a web font's): unreadable, and not ours.
    }
  }
  if (rules.length === 0) return;
  const root = getComputedStyle(document.documentElement);
  for (const name of Array.from(root)) {
    if (name.startsWith('--')) clone.style.setProperty(name, root.getPropertyValue(name));
  }
  const style = document.createElement('style');
  style.textContent = rules.join('\n');
  clone.prepend(style);
}

/** The part of a snapshot's pixels in the box (picture px, clamped to it). */
export function cropPixels(
  src: ImageData,
  x0: number,
  y0: number,
  w: number,
  h: number,
): ImageData {
  const out = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * src.width + x0) * 4;
    out.data.set(src.data.subarray(from, from + w * 4), y * w * 4);
  }
  return out;
}
