import { breakLayer } from './interfaceBreak';

/** How long the camera shakes, in ms. */
export const SHAKE_MS = 160;

/**
 * A short "camera" shake of the whole interface along (dx, dy), a unit
 * direction (default: vertical). `strength` scales the swing (1 ≈ 7px). The
 * page never scrolls, so the moving app can't flash a scrollbar. Interface
 * Breaks shake along, since they're on the interface.
 */
export function shake(el: HTMLElement | null, strength = 1, dx = 0, dy = 1) {
  if (!el) return;
  const keyframes = [0, -7, 5, -3, 2, 0].map((t) => ({
    translate: `${t * dx * strength}px ${t * dy * strength}px`,
  }));
  for (const target of [el, breakLayer()]) {
    target.animate(keyframes, { duration: SHAKE_MS, easing: 'ease-out' });
  }
}
