import { useState } from 'react';
import { z } from 'zod';
import { numberField } from '../core/fields';
import { defineManipulation, type EditorProps, type RenderContext } from '../core/manipulation';
import { cloneRaster } from '../core/raster';
import { useRender } from '../core/useRender';
import { OutputStatus } from '../ui/OutputStatus';
import { RasterView, type ImagePoint } from '../ui/RasterView';

const paramsSchema = z.object({});

/** Holes in input-normalized coordinates; r is relative to input width. */
const stateSchema = z.object({
  holes: z.array(z.object({ x: z.number(), y: z.number(), r: z.number().positive() })).default([]),
});

const toolsSchema = z.object({
  size: numberField({ label: 'Hole size (px)', min: 2, max: 600, default: 80 }),
});

type Params = z.output<typeof paramsSchema>;
type State = z.output<typeof stateSchema>;
type Tools = z.output<typeof toolsSchema>;

/** Punch anti-aliased circular holes through the ink. */
async function render({ input, state }: RenderContext<Params, State>) {
  const out = cloneRaster(input);
  const { width: w, height: h, data } = out;
  for (const hole of state.holes) {
    const cx = hole.x * w;
    const cy = hole.y * h;
    const r = hole.r * w;
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const keep = Math.min(1, Math.max(0, d - r + 0.5));
        data[(y * w + x) * 4 + 3] *= keep;
      }
    }
  }
  return { raster: out };
}

function HoleEditor({ input, params, state, setState, tools, seed, assets }: EditorProps<Params, State, Tools>) {
  const result = useRender(render, input, params, state, seed, assets);
  const [hover, setHover] = useState<ImagePoint | null>(null);

  return (
    <>
      <RasterView
        // Output is the same size as input, so image coords map 1:1.
        image={result.output?.raster ?? input}
        cursor="none"
        onPointerMove={setHover}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(p) =>
          setState((s) => ({
            ...s,
            holes: [...s.holes, { x: p.x / input.width, y: p.y / input.height, r: tools.size / 2 / input.width }],
          }))
        }
        overlay={
          hover && (
            <circle
              cx={hover.x}
              cy={hover.y}
              r={tools.size / 2}
              fill="none"
              stroke="#e5484d"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )
        }
      />
      <OutputStatus result={result} />
    </>
  );
}

export const hole = defineManipulation({
  id: 'hole',
  version: 1,
  label: 'Hole',
  paramsSchema,
  stateSchema,
  toolsSchema,
  render,
  Component: HoleEditor,
});
