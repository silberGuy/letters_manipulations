import { loadFont } from '../fonts';
import { context2d } from './raster';
import type { Source } from './recipe';

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/** Direction of a line from its first strong character. */
function lineDirection(line: string, setting: Source['direction']): 'rtl' | 'ltr' {
  if (setting !== 'auto') return setting;
  for (const ch of line) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (LTR_CHAR.test(ch)) return 'ltr';
  }
  return 'ltr';
}

export function applyTextStyle(ctx: OffscreenCanvasRenderingContext2D, font: string, letterSpacing: number) {
  ctx.font = font;
  // Not supported everywhere yet; where missing, spacing is simply ignored.
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${letterSpacing}px`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

export interface LineMetrics {
  text: string;
  direction: 'rtl' | 'ltr';
  /** Left edge of the line's text, in image px. */
  x: number;
  width: number;
  baseline: number;
}

/** Where the Source's lines go: shared by rasterizing and by the glyph layout. */
export interface SourceMetrics {
  fontString: string;
  width: number;
  height: number;
  ascent: number;
  descent: number;
  lines: LineMetrics[];
}

/** Lays out the Source's lines. Loads the font first, so metrics are never the fallback font's. */
export async function measureSource(source: Source): Promise<SourceMetrics> {
  const font = await loadFont(source.font, source.text);
  const fontString = `${font.style} ${font.weight} ${source.fontSize}px "${font.cssFamily}"`;

  const measure = context2d(new OffscreenCanvas(1, 1));
  applyTextStyle(measure, fontString, source.letterSpacing);

  const raw = source.text.split('\n').map((text) => {
    const direction = lineDirection(text, source.direction);
    measure.direction = direction;
    return { text, direction, width: measure.measureText(text).width };
  });

  const ref = measure.measureText('Hgבש');
  const ascent = ref.fontBoundingBoxAscent || source.fontSize * 0.8;
  const descent = ref.fontBoundingBoxDescent || source.fontSize * 0.2;
  const lineAdvance = source.fontSize * source.lineHeight;

  const contentWidth = Math.max(0, ...raw.map((l) => l.width));
  const contentHeight = ascent + descent + (raw.length - 1) * lineAdvance;
  const pad = source.padding;

  const lines = raw.map((line, i) => {
    const slack = contentWidth - line.width;
    const rtl = line.direction === 'rtl';
    const offset = source.align === 'center' ? slack / 2 : (source.align === 'start') === rtl ? slack : 0;
    return { ...line, x: pad + offset, baseline: pad + ascent + i * lineAdvance };
  });

  return {
    fontString,
    width: Math.max(1, Math.ceil(contentWidth + pad * 2)),
    height: Math.max(1, Math.ceil(contentHeight + pad * 2)),
    ascent,
    descent,
    lines,
  };
}

/** One grapheme's box in image px. */
export interface Glyph {
  /** The grapheme itself, for diffing. Newlines aren't Glyphs. */
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SourceLayout {
  /** Every grapheme of the Source in logical (typing) order. */
  glyphs: Glyph[];
  /** Font size in px; positions and lengths scale with it. */
  em: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Where each grapheme of the Source landed. Boxes come from measuring line
 * prefixes, so kerning and letter spacing are counted; mixed-direction lines
 * come out approximate.
 */
export async function layoutSource(source: Source): Promise<SourceLayout> {
  const metrics = await measureSource(source);
  const measure = context2d(new OffscreenCanvas(1, 1));
  applyTextStyle(measure, metrics.fontString, source.letterSpacing);

  const glyphs: Glyph[] = [];
  for (const line of metrics.lines) {
    measure.direction = line.direction;
    const y0 = line.baseline - metrics.ascent;
    const y1 = line.baseline + metrics.descent;
    let prefix = '';
    let before = 0;
    for (const { segment } of segmenter.segment(line.text)) {
      prefix += segment;
      const after = measure.measureText(prefix).width;
      // RTL text runs from the line's right edge leftwards.
      const a = line.direction === 'rtl' ? line.x + line.width - after : line.x + before;
      const b = line.direction === 'rtl' ? line.x + line.width - before : line.x + after;
      glyphs.push({ text: segment, x0: Math.min(a, b), x1: Math.max(a, b), y0, y1 });
      before = after;
    }
  }
  return { glyphs, em: source.fontSize };
}

const layoutCache = new Map<string, Promise<SourceLayout>>();
const LAYOUT_CACHE_SIZE = 16;

/** layoutSource, cached by Source. */
export function cachedLayout(source: Source): Promise<SourceLayout> {
  const key = JSON.stringify(source);
  let layout = layoutCache.get(key);
  if (!layout) {
    layout = layoutSource(source);
    layout.catch(() => layoutCache.delete(key));
    layoutCache.set(key, layout);
    if (layoutCache.size > LAYOUT_CACHE_SIZE) layoutCache.delete(layoutCache.keys().next().value!);
  }
  return layout;
}
