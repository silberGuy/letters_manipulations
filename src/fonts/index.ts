import type { FontRef } from '../core/recipe';
import { bundledFontLoader } from './bundled';
import { googleFontLoader } from './google';
import type { FontLoader, LoadedFont } from './loader';

export const FONT_LOADERS: FontLoader<any>[] = [googleFontLoader, bundledFontLoader];

export function getFontLoader(id: string): FontLoader<unknown> {
  const loader = FONT_LOADERS.find((l) => l.id === id);
  if (!loader) throw new Error(`Unknown font loader "${id}"`);
  return loader;
}

export function loadFont(ref: FontRef, text: string): Promise<LoadedFont> {
  const loader = getFontLoader(ref.loader);
  return loader.load(loader.argsSchema.parse(ref.args), text);
}
