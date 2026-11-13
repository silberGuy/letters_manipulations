import { z } from 'zod';
import type { FontLoader } from './loader';

/**
 * Fonts shipped with the project. Put the file in `public/fonts/` and add an
 * entry here.
 */
const BUNDLED_FONTS: { file: string; label: string }[] = [
  // { file: 'MyFont-Bold.woff2', label: 'My Font Bold' },
];

const argsSchema = z.object({ file: z.string() });
type BundledArgs = z.output<typeof argsSchema>;

const loaded = new Map<string, Promise<string>>();

export const bundledFontLoader: FontLoader<BundledArgs> = {
  id: 'bundled',
  argsSchema,
  async load({ file }) {
    const cssFamily = `bf-${file.replace(/[^\w-]/g, '_')}`;
    let pending = loaded.get(cssFamily);
    if (!pending) {
      pending = (async () => {
        const face = new FontFace(cssFamily, `url("${import.meta.env.BASE_URL}fonts/${encodeURIComponent(file)}")`);
        await face.load();
        document.fonts.add(face);
        return cssFamily;
      })();
      pending.catch(() => loaded.delete(cssFamily));
      loaded.set(cssFamily, pending);
    }
    return { cssFamily: await pending, weight: 'normal', style: 'normal' };
  },
  catalog() {
    return BUNDLED_FONTS.map(({ file, label }) => ({
      label,
      group: 'Bundled',
      variants: [{ label: 'Regular', args: { file } }],
    }));
  },
};
