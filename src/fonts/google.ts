import { z } from 'zod';
import type { FontFamilyOption, FontLoader } from './loader';

const range = (from: number, to: number) =>
  Array.from({ length: (to - from) / 100 + 1 }, (_, i) => from + i * 100);

interface CatalogEntry {
  family: string;
  weights: number[];
  hebrew: boolean;
}

/** Curated list. `hebrew` marks families that include Hebrew glyphs. */
const CATALOG: CatalogEntry[] = [
  // Hebrew
  { family: 'Rubik', weights: range(300, 900), hebrew: true },
  { family: 'Heebo', weights: range(100, 900), hebrew: true },
  { family: 'Assistant', weights: range(200, 800), hebrew: true },
  { family: 'Frank Ruhl Libre', weights: range(300, 900), hebrew: true },
  { family: 'David Libre', weights: [400, 500, 700], hebrew: true },
  { family: 'Noto Sans Hebrew', weights: range(100, 900), hebrew: true },
  { family: 'Noto Serif Hebrew', weights: range(100, 900), hebrew: true },
  { family: 'Noto Rashi Hebrew', weights: range(100, 900), hebrew: true },
  { family: 'IBM Plex Sans Hebrew', weights: range(100, 700), hebrew: true },
  { family: 'Miriam Libre', weights: [400, 700], hebrew: true },
  { family: 'Secular One', weights: [400], hebrew: true },
  { family: 'Suez One', weights: [400], hebrew: true },
  { family: 'Varela Round', weights: [400], hebrew: true },
  { family: 'Alef', weights: [400, 700], hebrew: true },
  { family: 'Amatic SC', weights: [400, 700], hebrew: true },
  { family: 'Bellefair', weights: [400], hebrew: true },
  { family: 'Karantina', weights: [300, 400, 700], hebrew: true },
  { family: 'Bona Nova', weights: [400, 700], hebrew: true },
  { family: 'Fredoka', weights: range(300, 700), hebrew: true },
  { family: 'Playpen Sans Hebrew', weights: range(100, 800), hebrew: true },
  { family: 'Solitreo', weights: [400], hebrew: true },
  { family: 'Rubik Dirt', weights: [400], hebrew: true },
  { family: 'Rubik Glitch', weights: [400], hebrew: true },
  { family: 'Rubik Wet Paint', weights: [400], hebrew: true },
  { family: 'Rubik Puddles', weights: [400], hebrew: true },
  { family: 'Rubik Spray Paint', weights: [400], hebrew: true },
  { family: 'Rubik Microbe', weights: [400], hebrew: true },
  { family: 'Rubik Moonrocks', weights: [400], hebrew: true },
  { family: 'Rubik Beastly', weights: [400], hebrew: true },
  { family: 'Rubik Vinyl', weights: [400], hebrew: true },
  { family: 'Rubik Bubbles', weights: [400], hebrew: true },
  // Latin
  { family: 'Inter', weights: range(100, 900), hebrew: false },
  { family: 'Fraunces', weights: range(100, 900), hebrew: false },
  { family: 'Playfair Display', weights: range(400, 900), hebrew: false },
  { family: 'Bodoni Moda', weights: range(400, 900), hebrew: false },
  { family: 'Space Grotesk', weights: range(300, 700), hebrew: false },
  { family: 'Unbounded', weights: range(200, 900), hebrew: false },
  { family: 'Syne', weights: range(400, 800), hebrew: false },
  { family: 'Instrument Serif', weights: [400], hebrew: false },
  { family: 'DM Serif Display', weights: [400], hebrew: false },
  { family: 'Bebas Neue', weights: [400], hebrew: false },
  { family: 'Anton', weights: [400], hebrew: false },
  { family: 'Archivo Black', weights: [400], hebrew: false },
  { family: 'Abril Fatface', weights: [400], hebrew: false },
  { family: 'Pacifico', weights: [400], hebrew: false },
];

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

const argsSchema = z.object({ family: z.string(), weight: z.number().int() });
type GoogleArgs = z.output<typeof argsSchema>;

const injected = new Map<string, Promise<string>>();

/**
 * Fetch the Google Fonts CSS and re-declare its @font-face rules under a
 * namespaced family, so it can't collide with the same family from another
 * loader.
 */
function injectCss({ family, weight }: GoogleArgs): Promise<string> {
  const cssFamily = `gf-${family.replace(/\s+/g, '_')}-${weight}`;
  let pending = injected.get(cssFamily);
  if (!pending) {
    pending = (async () => {
      const url = `https://fonts.googleapis.com/css2?family=${family.trim().replace(/ /g, '+')}:wght@${weight}&display=block`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Google Fonts: couldn't load ${family} ${weight} (HTTP ${res.status})`);
      const css = (await res.text()).replace(/font-family:\s*(['"])[^'"]+\1/g, `font-family: '${cssFamily}'`);
      const style = document.createElement('style');
      style.dataset.font = cssFamily;
      style.textContent = css;
      document.head.appendChild(style);
      return cssFamily;
    })();
    pending.catch(() => injected.delete(cssFamily));
    injected.set(cssFamily, pending);
  }
  return pending;
}

export const googleFontLoader: FontLoader<GoogleArgs> = {
  id: 'google',
  argsSchema,
  async load(args, text) {
    const cssFamily = await injectCss(args);
    // Google splits fonts by unicode-range (e.g. Hebrew vs Latin); passing the
    // real text makes the browser fetch every subset the text needs.
    await document.fonts.load(`${args.weight} 64px "${cssFamily}"`, text || 'a');
    return { cssFamily, weight: args.weight, style: 'normal' };
  },
  catalog(): FontFamilyOption[] {
    return CATALOG.map(({ family, weights, hebrew }) => ({
      label: family,
      group: hebrew ? 'Google · Hebrew' : 'Google · Latin',
      variants: weights.map((weight) => ({
        label: `${weight} ${WEIGHT_NAMES[weight] ?? ''}`.trim(),
        args: { family, weight },
      })),
    }));
  },
};
