import type { z } from 'zod';

export interface LoadedFont {
  /** Namespaced CSS family, unique per loader + font, ready for canvas `font`. */
  cssFamily: string;
  weight: number | string;
  style: string;
}

export interface FontVariant {
  label: string;
  args: unknown;
}

export interface FontFamilyOption {
  label: string;
  group: string;
  variants: FontVariant[];
}

/**
 * A source of fonts. A Recipe stores `{ loader: id, args }`; the loader turns
 * the args back into a usable font. Adding a new source of fonts (uploads,
 * another catalog) means registering another loader — nothing else changes.
 */
export interface FontLoader<A = unknown> {
  id: string;
  argsSchema: z.ZodType<A>;
  /** `text` is what will be drawn, so loaders can fetch the right glyph subsets. */
  load(args: A, text: string): Promise<LoadedFont>;
  /** Browsable fonts, if the loader has a list. */
  catalog?(): FontFamilyOption[];
}
