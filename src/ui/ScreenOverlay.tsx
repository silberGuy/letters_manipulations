import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { matrixAttr } from './interfaceBreak';

/**
 * SVG content drawn over the whole interface, in a Canvas's image px placed
 * by `toScreen` (image px → viewport px). Ignores the pointer. For things that
 * must leave the Canvas, like a crosshair aiming at the interface.
 */
export function ScreenOverlay({ toScreen, children }: { toScreen: DOMMatrixReadOnly; children: ReactNode }) {
  return createPortal(
    <svg className="screen-overlay">
      <g transform={matrixAttr(toScreen)}>{children}</g>
    </svg>,
    document.body,
  );
}
