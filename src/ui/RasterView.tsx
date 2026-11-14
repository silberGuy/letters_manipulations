import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { rasterToCanvas } from '../core/raster';
import { useStore } from '../store/store';

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
 * Fills its container. Shows an ImageData centered at its own pixel size
 * (scaled down to fit, never up), with an SVG overlay spanning the whole
 * container and pointer events mapped to image pixel coordinates — so points
 * outside the image are reachable too (negative or beyond width/height).
 */
export function RasterView({ image, overlay, cursor, onPointerDown, onPointerMove, onPointerUp, onPointerLeave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const showExportBounds = useStore((s) => s.showExportBounds);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [image === null]);

  // Screen px per image px. Scale down to fit, never up.
  const scale =
    image && box.width && box.height ? Math.min(1, box.width / image.width, box.height / image.height) : 1;
  // Device px per image px for the canvas backing store. Shrinking here with
  // high-quality smoothing looks much better than letting CSS shrink it.
  const pixelScale = Math.min(1, scale * (window.devicePixelRatio || 1));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext('2d')!;
    if (pixelScale >= 1) {
      canvas.width = image.width;
      canvas.height = image.height;
      ctx.putImageData(image, 0, 0);
      return;
    }
    canvas.width = Math.max(1, Math.round(image.width * pixelScale));
    canvas.height = Math.max(1, Math.round(image.height * pixelScale));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(rasterToCanvas(image), 0, 0, canvas.width, canvas.height);
  }, [image, pixelScale]);

  if (!image) return null;

  // The whole container, expressed in image pixel coordinates.
  const viewW = box.width / scale || image.width;
  const viewH = box.height / scale || image.height;
  const viewX = (image.width - viewW) / 2;
  const viewY = (image.height - viewH) / 2;

  const toImage = (e: PointerEvent<SVGSVGElement>): ImagePoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: viewX + (e.clientX - rect.left) / scale,
      y: viewY + (e.clientY - rect.top) / scale,
    };
  };

  return (
    <div className="raster-view" ref={boxRef}>
      <canvas ref={canvasRef} style={{ width: image.width * scale, height: image.height * scale }} />
      <svg
        viewBox={`${viewX} ${viewY} ${viewW} ${viewH}`}
        style={{ cursor }}
        onPointerDown={onPointerDown && ((e) => onPointerDown(toImage(e), e))}
        onPointerMove={onPointerMove && ((e) => onPointerMove(toImage(e), e))}
        onPointerUp={onPointerUp && ((e) => onPointerUp(toImage(e), e))}
        onPointerLeave={onPointerLeave}
      >
        {showExportBounds && (
          <rect className="export-bounds" x={0} y={0} width={image.width} height={image.height} vectorEffect="non-scaling-stroke" />
        )}
        {overlay}
      </svg>
    </div>
  );
}
