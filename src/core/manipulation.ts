import type { ComponentType } from 'react';
import type { z } from 'zod';
import type { Remap } from './remap';
import type { Rng } from './rng';

/** What a Manipulation produces. Raster always; vector when it has one. */
export interface Output {
  raster: ImageData;
  /**
   * Native vector, if the Manipulation has one. Return a function when it's
   * costly to build: it's only called when the Output is exported, never for
   * the live preview. It must be deterministic like render itself.
   */
  svg?: string | (() => Promise<string>);
}

/** Read access to the Recipe's Assets. */
export interface AssetResolver {
  getBlob(hash: string): Blob | undefined;
  getImageData(hash: string): Promise<ImageData>;
}

/**
 * `draft` renders fast for the live preview while the user interacts; `final`
 * is the Recipe's real Output (export, chained Steps, and the preview once
 * interaction settles). A Manipulation may ignore it; one that reads it must
 * give the same picture in both, only at different quality.
 */
export type RenderQuality = 'draft' | 'final';

export interface RenderContext<P, S> {
  /** RGBA input. Not to be mutated. */
  input: ImageData;
  params: P;
  state: S;
  rng: Rng;
  assets: AssetResolver;
  quality: RenderQuality;
}

export type Updater<T> = T | ((prev: T) => T);

export interface EditorProps<P, S, T> {
  input: ImageData;
  params: P;
  setParams(update: Updater<P>): void;
  /**
   * Commit State. Keep in-progress gestures in local component state and
   * commit when the gesture ends: anything render reads must be in State by
   * then.
   */
  state: S;
  setState(update: Updater<S>): void;
  tools: T;
  seed: number;
  assets: AssetResolver;
}

export interface ManipulationDefinition<
  PS extends z.ZodObject,
  SS extends z.ZodObject,
  TS extends z.ZodObject,
> {
  id: string;
  /** Bump when render changes so older Recipes would come out differently. */
  version: number;
  label: string;
  /** Read by render; in the Recipe; controls generated. Every field needs a default. */
  paramsSchema: PS;
  /** Produced by interacting with the editor; in the Recipe; no generated UI. */
  stateSchema: SS;
  /** Shape interaction only; never read by render; not in the Recipe. */
  toolsSchema: TS;
  /** Deterministic given its context. Used by the editor and for replay/export. */
  render(ctx: RenderContext<z.output<PS>, z.output<SS>>): Promise<Output>;
  /**
   * Move State along with the text when the Source changes, so effects stay on
   * their letters. Must keep the order of what it keeps (render's randomness
   * may depend on it) and may drop effects whose letters were deleted. Without
   * it, State stays where it is.
   */
  remapState?(state: z.output<SS>, remap: Remap): z.output<SS>;
  Component: ComponentType<EditorProps<z.output<PS>, z.output<SS>, z.output<TS>>>;
}

type Values = Record<string, unknown>;

/** A Manipulation with its types erased, as held by the registry and the store. */
export interface Manipulation {
  id: string;
  version: number;
  label: string;
  paramsSchema: z.ZodObject;
  stateSchema: z.ZodObject;
  toolsSchema: z.ZodObject;
  render(ctx: RenderContext<Values, Values>): Promise<Output>;
  remapState?(state: Values, remap: Remap): Values;
  Component: ComponentType<EditorProps<Values, Values, Values>>;
}

export function defineManipulation<
  PS extends z.ZodObject,
  SS extends z.ZodObject,
  TS extends z.ZodObject,
>(definition: ManipulationDefinition<PS, SS, TS>): Manipulation {
  return definition as unknown as Manipulation;
}
