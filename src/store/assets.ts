import type { AssetResolver } from '../core/manipulation';
import { context2d } from '../core/raster';
import { useStore } from './store';

// Assets are content-addressed, so a decoded image never goes stale.
const decoded = new Map<string, Promise<ImageData>>();

/** Stable singleton, so it never retriggers renders by identity. */
export const assetResolver: AssetResolver = {
  getBlob: (hash) => useStore.getState().assetBlobs[hash],
  getImageData(hash) {
    let pending = decoded.get(hash);
    if (!pending) {
      const blob = useStore.getState().assetBlobs[hash];
      if (!blob) return Promise.reject(new Error(`Missing asset ${hash}`));
      pending = createImageBitmap(blob).then((bitmap) => {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = context2d(canvas);
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      });
      decoded.set(hash, pending);
    }
    return pending;
  },
};
