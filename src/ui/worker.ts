import { FrameAnimation, preloadFrames } from './frameAnimation';

const frame = (name: string) => new URL(`../static/${name}.png`, import.meta.url).href;

/** Walking to the right; flipped to walk left. */
const WALK = [1, 2, 3].map((i) => frame(`worker_walk_right${i}`));
const WORK = [1, 2, 3, 4].map((i) => frame(`worker_work${i}`));
preloadFrames(WALK, WORK);

/** Frames per second, walking and working. */
const WORKER_FPS = 7;
/** A Worker's size on screen, in px. */
const WORKER_SIZE = 56;
/** Walking speed, in screen px per second. */
const WALK_SPEED = 260;

export interface WorkerJob {
  /** Where the break is, in viewport px. */
  x: number;
  y: number;
  /** How far the break reaches from (x, y), in viewport px: the Worker stops at its edge. */
  radius: number;
  /** How long to work once there, in ms. */
  workMs: number;
}

/**
 * Send a Worker to an Interface Break: it walks in from an edge of the screen
 * (usually a near one), upright and flipped when heading left, then works on
 * the break. Resolves when the work is done; the Worker is removed then.
 * `container` is the break's own container, so the Worker goes with it.
 */
export async function sendWorker(container: HTMLElement, job: WorkerJob): Promise<void> {
  const worker = spawnWorker(container, job.x, job.y, job.radius, 0, 'likely');
  try {
    await worker.arrived;
    await wait(job.workMs);
  } finally {
    worker.remove();
  }
}

/** Workers set out up to this long after one another, in ms, so they don't march in step. */
const STAGGER_MS = 350;

/**
 * Send a crew of Workers to an Interface Break along a line, one to each
 * spot (viewport px). Once the last one gets there, they all work for
 * `workMs`, then resolve; they're all removed then.
 */
export async function sendWorkers(
  container: HTMLElement,
  spots: readonly { x: number; y: number }[],
  workMs: number,
): Promise<void> {
  // Each from the edge nearest its spot, so the crew fans out from the
  // sides closest to the line.
  const crew = spots.map((p) =>
    spawnWorker(container, p.x, p.y, 0, Math.random() * STAGGER_MS, 'nearest'),
  );
  try {
    await Promise.all(crew.map((w) => w.arrived));
    await wait(workMs);
  } finally {
    for (const w of crew) w.remove();
  }
}

/** One Worker per this many px along a line, at most. */
const CREW_SPACING = WORKER_SIZE * 1.1;
/** The most Workers a crew can have. */
const MAX_CREW = 40;

/**
 * Spots for a crew along a line of points (viewport px), about one Worker's
 * width apart. `keep` leaves out stretches (e.g. on the Canvas) and spots off
 * the screen are dropped.
 */
export function crewSpots(
  line: readonly { x: number; y: number }[],
  keep: (p: { x: number; y: number }) => boolean = () => true,
): { x: number; y: number }[] {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const spots: { x: number; y: number }[] = [];
  let since = Infinity;
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    if (i > 0) since += Math.hypot(p.x - line[i - 1].x, p.y - line[i - 1].y);
    const shown = p.x >= 0 && p.x < W && p.y >= 0 && p.y < H && keep(p);
    if (shown && since >= CREW_SPACING) {
      spots.push(p);
      since = 0;
    }
  }
  // Too many: spread the ones we keep evenly.
  if (spots.length <= MAX_CREW) return spots;
  return Array.from({ length: MAX_CREW }, (_, i) => spots[Math.floor((i * spots.length) / MAX_CREW)]);
}

/**
 * A Worker walking in to (x, y) (stopping `radius` short of it), setting out
 * after `delayMs`. `arrived` resolves when it gets there and starts working.
 */
function spawnWorker(
  container: HTMLElement,
  x: number,
  y: number,
  radius: number,
  delayMs: number,
  edge: EdgeChoice,
): { arrived: Promise<void>; remove(): void } {
  const angle = approachAngle(x, y, edge);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  // Stop at the near edge of the break, overlapping it a little.
  const stop = Math.max(0, radius - WORKER_SIZE * 0.15);
  const end = { x: x - dx * stop, y: y - dy * stop };
  // Start just off screen, back along the way it walks.
  const back = exitDistance(end, -dx, -dy) + WORKER_SIZE;
  const start = { x: end.x - dx * back, y: end.y - dy * back };

  const anim = new FrameAnimation(WORKER_FPS);
  const el = anim.element;
  el.classList.add('worker');
  el.style.width = `${WORKER_SIZE}px`;
  el.style.height = `${WORKER_SIZE}px`;
  el.style.margin = `${-WORKER_SIZE / 2}px 0 0 ${-WORKER_SIZE / 2}px`;
  // The frames face right: heading left, mirror it. Always upright.
  el.style.scale = dx < 0 ? '-1 1' : '1 1';
  el.style.translate = `${start.x}px ${start.y}px`;
  container.append(el);

  anim.play(WALK);
  const walk = el.animate(
    [{ translate: `${start.x}px ${start.y}px` }, { translate: `${end.x}px ${end.y}px` }],
    {
      duration: (back / WALK_SPEED) * 1000,
      delay: delayMs,
      easing: 'linear',
      fill: 'both',
    },
  );
  const arrived = walk.finished.then(() => anim.play(WORK));
  return {
    // Removed before arriving: never mind.
    arrived: arrived.catch(() => {}),
    remove() {
      walk.cancel();
      anim.stop();
      el.remove();
    },
  };
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** How far a Worker's way may turn from straight in off its edge, in radians. */
const APPROACH_SPREAD = (35 * Math.PI) / 180;

/**
 * Which screen edge a Worker comes in from: the `nearest` one, or a `likely`
 * one (usually near: picked with weight 1 / distance²).
 */
type EdgeChoice = 'nearest' | 'likely';

/**
 * Which way a Worker walks to reach (x, y): in from one of the screen's
 * edges, roughly straight in from it.
 */
function approachAngle(x: number, y: number, choice: EdgeChoice): number {
  const W = window.innerWidth;
  const H = window.innerHeight;
  // Each edge: how far it is, and the way straight in from it.
  const edges = [
    { d: x, angle: 0 }, // left: walk right
    { d: W - x, angle: Math.PI }, // right: walk left
    { d: y, angle: Math.PI / 2 }, // top: walk down
    { d: H - y, angle: -Math.PI / 2 }, // bottom: walk up
  ];
  if (choice === 'nearest') {
    const edge = edges.reduce((a, b) => (b.d < a.d ? b : a));
    return edge.angle + (Math.random() * 2 - 1) * APPROACH_SPREAD;
  }
  const weights = edges.map((e) => 1 / Math.max(1, e.d) ** 2);
  let pick = Math.random() * weights.reduce((a, b) => a + b, 0);
  let edge = edges[0];
  for (let i = 0; i < edges.length; i++) {
    pick -= weights[i];
    if (pick <= 0) {
      edge = edges[i];
      break;
    }
  }
  return edge.angle + (Math.random() * 2 - 1) * APPROACH_SPREAD;
}

/** How far from p, heading along (dx, dy), until it leaves the viewport. */
function exitDistance(p: { x: number; y: number }, dx: number, dy: number): number {
  const W = window.innerWidth;
  const H = window.innerHeight;
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (W - p.x) / dx);
  if (dx < -1e-9) t = Math.min(t, -p.x / dx);
  if (dy > 1e-9) t = Math.min(t, (H - p.y) / dy);
  if (dy < -1e-9) t = Math.min(t, -p.y / dy);
  return Math.max(0, t);
}
