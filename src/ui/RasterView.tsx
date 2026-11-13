import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react';

export interface ImagePoint {
  /** In image pixels. */
  x: number;
  y: number;
}

interface Props {
  image: ImageData | null;
  /** SVG content drawn on top, in image pixel coordinates. */
  overlay?: ReactNode;
  cursor?: string;
  onPointerDown?(p: ImagePoint, e: PointerEvent<SVGSVGElement>): void;
  onPointerMove?(p: ImagePoint, e: PointerEvent<SVGSVGElement>): void;
  onPointerUp?(p: ImagePoint, e: PointerEvent<SVGSVGElement>): void;
  onPointerLeave?(): void;
}

/**
 * Shows an ImageData at its own pixel size, scaled down by CSS to fit, with an
 * SVG overlay and pointer events mapped to image pixel coordinates.
 */
export function RasterView({ image, overlay, cursor, onPointerDown, onPointerMove, onPointerUp, onPointerLeave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d')!.putImageData(image, 0, 0);
  }, [image]);

  if (!image) return null;

  const toImage = (e: PointerEvent<SVGSVGElement>): ImagePoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * image.width,
      y: ((e.clientY - rect.top) / rect.height) * image.height,
    };
  };

  return (
    <div className="raster-view">
      <canvas ref={canvasRef} />
      <svg
        viewBox={`0 0 ${image.width} ${image.height}`}
        style={{ cursor }}
        onPointerDown={onPointerDown && ((e) => onPointerDown(toImage(e), e))}
        onPointerMove={onPointerMove && ((e) => onPointerMove(toImage(e), e))}
        onPointerUp={onPointerUp && ((e) => onPointerUp(toImage(e), e))}
        onPointerLeave={onPointerLeave}
      >
        {overlay}
      </svg>
    </div>
  );
}
