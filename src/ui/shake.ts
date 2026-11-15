/** How long the camera shakes, in ms. */
export const SHAKE_MS = 160;

/** Shakes in progress; the page's overflow is hidden while any run. */
let activeShakes = 0;

/**
 * A short "camera" shake of the whole interface along (dx, dy), a unit
 * direction (default: vertical). `strength` scales the swing (1 ≈ 7px). Hides
 * the page's overflow meanwhile so the moving app can't flash a scrollbar.
 */
export function shake(el: HTMLElement | null, strength = 1, dx = 0, dy = 1) {
  if (!el) return;
  activeShakes++;
  document.body.style.overflow = 'hidden';
  const animation = el.animate(
    [0, -7, 5, -3, 2, 0].map((t) => ({ translate: `${t * dx * strength}px ${t * dy * strength}px` })),
    { duration: SHAKE_MS, easing: 'ease-out' },
  );
  const done = () => {
    if (--activeShakes === 0) document.body.style.overflow = '';
  };
  animation.addEventListener('finish', done);
  animation.addEventListener('cancel', done);
}
