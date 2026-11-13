import { createRaster } from "./raster";

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

/** An image being pushed: open holes in order, then read it back as ImageData. */
export class PushCanvas {
	readonly width: number;
	readonly height: number;
	/** Premultiplied RGBA as floats. */
	private buf: Float32Array;
	/** 1 where any hole has moved the pixel. */
	private pushed: Uint8Array;
	private px = new Float32Array(4);

	/** Copies `input`; never mutates it. */
	constructor(input: ImageData) {
		const { width: W, height: H, data } = input;
		this.width = W;
		this.height = H;
		this.buf = new Float32Array(W * H * 4);
		this.pushed = new Uint8Array(W * H);
		for (let i = 0; i < W * H; i++) {
			const a = data[i * 4 + 3] / 255;
			this.buf[i * 4] = (data[i * 4] / 255) * a;
			this.buf[i * 4 + 1] = (data[i * 4 + 1] / 255) * a;
			this.buf[i * 4 + 2] = (data[i * 4 + 2] / 255) * a;
			this.buf[i * 4 + 3] = a;
		}
	}

	/** Alpha (0..1) at image point (x, y), bilinearly sampled. */
	alphaAt(x: number, y: number): number {
		this.sample(x - 0.5, y - 0.5, this.px);
		return this.px[3];
	}

	/**
	 * Open one hole. In the ellipse's normalized frame (where it's the unit
	 * circle), a point at distance ρ came from √(ρ² − 1): the ring of material
	 * keeps its area as the hole opens. The push is scaled by `strength`
	 * (0 = a plain hole) and fades to nothing at `reach`, which keeps the map
	 * monotonic (no folds).
	 */
	open(e: Ellipse, strength: number) {
		const { width: W, height: H, buf, pushed } = this;
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
		const tmp = new Float32Array(bw * (y1 - y0 + 1) * 4);
		const px = this.px;
		const R = e.reach;

		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				const t = ((y - y0) * bw + (x - x0)) * 4;
				const dx = x + 0.5 - e.cx;
				const dy = y + 0.5 - e.cy;
				const u = dx * cos + dy * sin;
				const v = -dx * sin + dy * cos;
				const qx = u / e.a;
				const qy = v / e.b;
				const rho = Math.hypot(qx, qy);
				const k = (y * W + x) * 4;
				if (rho >= R) {
					tmp[t] = buf[k];
					tmp[t + 1] = buf[k + 1];
					tmp[t + 2] = buf[k + 2];
					tmp[t + 3] = buf[k + 3];
					continue;
				}
				pushed[y * W + x] = 1;
				if (rho < 1e-6) continue; // Center of the hole: transparent.
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
				this.sample(
					e.cx + su * cos - sv * sin - 0.5,
					e.cy + su * sin + sv * cos - 0.5,
					px,
				);
				tmp[t] = px[0] * cov;
				tmp[t + 1] = px[1] * cov;
				tmp[t + 2] = px[2] * cov;
				tmp[t + 3] = px[3] * cov;
			}
		}

		for (let y = y0; y <= y1; y++) {
			const row = (y - y0) * bw * 4;
			buf.set(tmp.subarray(row, row + bw * 4), (y * W + x0) * 4);
		}
	}

	/**
	 * The result. Pushed pixels fainter than `minPushedAlpha` (0..1) are
	 * removed, so smeared ink doesn't leave a haze.
	 */
	toImageData(minPushedAlpha: number): ImageData {
		const { width: W, height: H, buf, pushed } = this;
		const out = createRaster(W, H);
		const o = out.data;
		for (let i = 0; i < W * H; i++) {
			const a = buf[i * 4 + 3];
			if (a <= 0 || (pushed[i] && a < minPushedAlpha)) continue;
			o[i * 4] = Math.round((buf[i * 4] / a) * 255);
			o[i * 4 + 1] = Math.round((buf[i * 4 + 1] / a) * 255);
			o[i * 4 + 2] = Math.round((buf[i * 4 + 2] / a) * 255);
			o[i * 4 + 3] = Math.round(a * 255);
		}
		return out;
	}

	/** Bilinear sample at (x, y) in pixel-center coordinates; transparent outside. */
	private sample(x: number, y: number, out: Float32Array) {
		const { width: W, height: H, buf } = this;
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		const fx = x - x0;
		const fy = y - y0;
		out.fill(0);
		for (let j = 0; j < 2; j++) {
			const yy = y0 + j;
			if (yy < 0 || yy >= H) continue;
			const wy = j ? fy : 1 - fy;
			for (let i = 0; i < 2; i++) {
				const xx = x0 + i;
				if (xx < 0 || xx >= W) continue;
				const w = wy * (i ? fx : 1 - fx);
				const k = (yy * W + xx) * 4;
				out[0] += buf[k] * w;
				out[1] += buf[k + 1] * w;
				out[2] += buf[k + 2] * w;
				out[3] += buf[k + 3] * w;
			}
		}
	}
}
