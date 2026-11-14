import type { RenderQuality } from "./manipulation";
import { createRaster, samplerFor } from "./raster";

/**
 * Pushing: holes that open like holes in incompressible rubber. The material
 * inside a hole isn't erased; it's pushed out around it, so ink near a hole
 * bulges outward (even past the letter's edge) and thins as it stretches.
 * Holes are opened one at a time, so each new hole also pushes earlier ones.
 */

/** An elliptical hole, in image pixels. A circle has a === b. */
export interface Ellipse {
	cx: number;
	cy: number;
	/** Angle of the `a` axis, radians. */
	angle: number;
	a: number;
	b: number;
	/** The push fades out at this many radii (≥ 1). */
	reach: number;
}

const smoothstep = (e0: number, e1: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
	return t * t * (3 - 2 * t);
};

/**
 * An image being pushed: open holes in order, then read it back as ImageData.
 *
 * Holes don't move pixels. Each output pixel keeps a note of where in the
 * input it comes from (a map) and how much of it survives (a mask), and each
 * hole updates those notes. The input is sampled once, in toImageData, so the
 * ink is resampled (and softened) once no matter how many holes overlap.
 */
export class PushCanvas {
	readonly width: number;
	readonly height: number;
	private input: ImageData;
	private quality: RenderQuality;
	/** Where each pixel comes from, in input pixel-center coordinates. */
	private mapX: Float32Array;
	private mapY: Float32Array;
	/** How much of each pixel survives (0..1): holes clear it. */
	private mask: Float32Array;
	/** 1 where any hole has moved the pixel. */
	private pushed: Uint8Array;
	private m = new Float32Array(3);

	/** Reads `input`; never mutates it. `quality` picks the final sampling kernel. */
	constructor(input: ImageData, quality: RenderQuality) {
		const { width: W, height: H } = input;
		this.width = W;
		this.height = H;
		this.input = input;
		this.quality = quality;
		this.mapX = new Float32Array(W * H);
		this.mapY = new Float32Array(W * H);
		this.mask = new Float32Array(W * H).fill(1);
		this.pushed = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				this.mapX[y * W + x] = x;
				this.mapY[y * W + x] = y;
			}
		}
	}

	/** Alpha (0..1) of the pushed image at image point (x, y), bilinearly sampled. */
	alphaAt(x: number, y: number): number {
		const m = this.m;
		this.lookup(x - 0.5, y - 0.5, m);
		if (m[2] <= 0) return 0;
		const { width: W, height: H, data } = this.input;
		const x0 = Math.floor(m[0]);
		const y0 = Math.floor(m[1]);
		const fx = m[0] - x0;
		const fy = m[1] - y0;
		let a = 0;
		for (let j = 0; j < 2; j++) {
			const yy = y0 + j;
			if (yy < 0 || yy >= H) continue;
			for (let i = 0; i < 2; i++) {
				const xx = x0 + i;
				if (xx < 0 || xx >= W) continue;
				a += data[(yy * W + xx) * 4 + 3] * (j ? fy : 1 - fy) * (i ? fx : 1 - fx);
			}
		}
		return (a / 255) * m[2];
	}

	/**
	 * Open one hole. In the ellipse's normalized frame (where it's the unit
	 * circle), a point at distance ρ came from √(ρ² − 1): the ring of material
	 * keeps its area as the hole opens. The push is scaled by `strength`
	 * (0 = a plain hole) and fades to nothing at `reach`, which keeps the map
	 * monotonic (no folds).
	 */
	open(e: Ellipse, strength: number) {
		const { width: W, height: H, mapX, mapY, mask, pushed } = this;
		const cos = Math.cos(e.angle);
		const sin = Math.sin(e.angle);
		const A = e.a * e.reach;
		const B = e.b * e.reach;
		const ex = Math.sqrt(A * A * cos * cos + B * B * sin * sin);
		const ey = Math.sqrt(A * A * sin * sin + B * B * cos * cos);
		const x0 = Math.max(0, Math.floor(e.cx - ex));
		const x1 = Math.min(W - 1, Math.ceil(e.cx + ex));
		const y0 = Math.max(0, Math.floor(e.cy - ey));
		const y1 = Math.min(H - 1, Math.ceil(e.cy + ey));
		if (x0 > x1 || y0 > y1) return;

		const bw = x1 - x0 + 1;
		// New map and mask for the box: [mapX, mapY, mask] per pixel.
		const tmp = new Float32Array(bw * (y1 - y0 + 1) * 3);
		const m = this.m;
		const R = e.reach;

		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				const t = ((y - y0) * bw + (x - x0)) * 3;
				const k = y * W + x;
				const dx = x + 0.5 - e.cx;
				const dy = y + 0.5 - e.cy;
				const u = dx * cos + dy * sin;
				const v = -dx * sin + dy * cos;
				const qx = u / e.a;
				const qy = v / e.b;
				const rho = Math.hypot(qx, qy);
				tmp[t] = mapX[k];
				tmp[t + 1] = mapY[k];
				if (rho >= R) {
					tmp[t + 2] = mask[k];
					continue;
				}
				pushed[k] = 1;
				if (rho < 1e-6) continue; // Center of the hole: cleared (mask 0).
				// Signed distance to the hole's edge in pixels (first order), for anti-aliasing.
				const grad = Math.hypot(qx / e.a, qy / e.b) / rho;
				const cov = Math.min(1, Math.max(0, (rho - 1) / grad + 0.5));
				if (cov === 0) continue;
				const r = Math.max(1, rho);
				const push = r - Math.sqrt(r * r - 1);
				const rhoIn = r - strength * (1 - smoothstep(1, R, r)) * push;
				const f = rhoIn / rho;
				const su = u * f;
				const sv = v * f;
				this.lookup(
					e.cx + su * cos - sv * sin - 0.5,
					e.cy + su * sin + sv * cos - 0.5,
					m,
				);
				tmp[t] = m[0];
				tmp[t + 1] = m[1];
				tmp[t + 2] = m[2] * cov;
			}
		}

		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				const t = ((y - y0) * bw + (x - x0)) * 3;
				const k = y * W + x;
				mapX[k] = tmp[t];
				mapY[k] = tmp[t + 1];
				mask[k] = tmp[t + 2];
			}
		}
	}

	/**
	 * The result: the input, sampled once through the map. Pushed pixels fainter
	 * than `minPushedAlpha` (0..1) are removed, so smeared ink doesn't leave a haze.
	 */
	toImageData(minPushedAlpha: number): ImageData {
		const { width: W, height: H, mapX, mapY, mask, pushed } = this;
		const src = this.input.data;
		const sample = samplerFor(this.quality);
		const out = createRaster(W, H);
		const o = out.data;
		const minAlpha = minPushedAlpha * 255;
		for (let i = 0; i < W * H; i++) {
			const p = i * 4;
			if (!pushed[i]) {
				o[p] = src[p];
				o[p + 1] = src[p + 1];
				o[p + 2] = src[p + 2];
				o[p + 3] = src[p + 3];
				continue;
			}
			if (mask[i] <= 0) continue;
			sample(src, W, H, mapX[i], mapY[i], o, p);
			const a = o[p + 3] * mask[i];
			if (a < minAlpha) {
				o[p] = o[p + 1] = o[p + 2] = o[p + 3] = 0;
				continue;
			}
			o[p + 3] = Math.round(a);
		}
		return out;
	}

	/**
	 * The map and mask at (x, y) in pixel-center coordinates, bilinearly
	 * interpolated. Outside the image nothing was ever pushed, so the map is the
	 * identity there (the input is transparent outside anyway).
	 */
	private lookup(x: number, y: number, out: Float32Array) {
		const { width: W, height: H, mapX, mapY, mask } = this;
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		const fx = x - x0;
		const fy = y - y0;
		out.fill(0);
		for (let j = 0; j < 2; j++) {
			const yy = y0 + j;
			const wy = j ? fy : 1 - fy;
			for (let i = 0; i < 2; i++) {
				const xx = x0 + i;
				const w = wy * (i ? fx : 1 - fx);
				if (xx < 0 || yy < 0 || xx >= W || yy >= H) {
					out[0] += xx * w;
					out[1] += yy * w;
					out[2] += w;
					continue;
				}
				const k = yy * W + xx;
				out[0] += mapX[k] * w;
				out[1] += mapY[k] * w;
				out[2] += mask[k] * w;
			}
		}
	}
}
