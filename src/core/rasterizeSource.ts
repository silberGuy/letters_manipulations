import { loadFont } from '../fonts';
import { context2d } from './raster';
import type { Source } from './recipe';

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
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

function applyTextStyle(ctx: OffscreenCanvasRenderingContext2D, font: string, letterSpacing: number) {
  ctx.font = font;
  // Not supported everywhere yet; where missing, spacing is simply ignored.
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${letterSpacing}px`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/**
 * Draw the Source as black ink on transparent paper. The canvas is fitted to
 * the text plus padding.
 */
export async function rasterizeSource(source: Source): Promise<ImageData> {
  const font = await loadFont(source.font, source.text);
  const fontString = `${font.style} ${font.weight} ${source.fontSize}px "${font.cssFamily}"`;

  const measure = context2d(new OffscreenCanvas(1, 1));
  applyTextStyle(measure, fontString, source.letterSpacing);

  const lines = source.text.split('\n').map((text) => {
    const direction = lineDirection(text, source.direction);
    measure.direction = direction;
    return { text, direction, width: measure.measureText(text).width };
  });

  const ref = measure.measureText('Hgבש');
  const ascent = ref.fontBoundingBoxAscent || source.fontSize * 0.8;
  const descent = ref.fontBoundingBoxDescent || source.fontSize * 0.2;
  const lineAdvance = source.fontSize * source.lineHeight;

  const contentWidth = Math.max(0, ...lines.map((l) => l.width));
  const contentHeight = ascent + descent + (lines.length - 1) * lineAdvance;
  const pad = source.padding;
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.ceil(contentWidth + pad * 2)),
    Math.max(1, Math.ceil(contentHeight + pad * 2)),
  );
  const ctx = context2d(canvas);
  applyTextStyle(ctx, fontString, source.letterSpacing);
  ctx.fillStyle = '#000';

  lines.forEach((line, i) => {
    const slack = contentWidth - line.width;
    const rtl = line.direction === 'rtl';
    const offset =
      source.align === 'center' ? slack / 2 : (source.align === 'start') === rtl ? slack : 0;
    ctx.direction = line.direction;
    ctx.fillText(line.text, pad + offset, pad + ascent + i * lineAdvance);
  });

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
