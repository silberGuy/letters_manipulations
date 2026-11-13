import { create } from 'zustand';
import type { Manipulation, Updater } from '../core/manipulation';
import { defaultSource, type Recipe, type Source, type Step } from '../core/recipe';
import { randomSeed } from '../core/rng';
import { getManipulation, MANIPULATIONS } from '../manipulations';

type Values = Record<string, unknown>;

export interface AppStore {
  recipe: Recipe;
  /** Asset bytes by content hash. Metadata lives in recipe.assets. */
  assetBlobs: Record<string, Blob>;
  /** Tool settings per Manipulation id. Not part of the Recipe. */
  tools: Record<string, Values>;
  /** Messages from loading a Recipe (e.g. version mismatches). */
  warnings: string[];

  setSource(patch: Partial<Source>): void;
  selectManipulation(stepIndex: number, id: string): void;
  setParams(stepIndex: number, update: Updater<Values>): void;
  setState(stepIndex: number, update: Updater<Values>): void;
  setSeed(stepIndex: number, seed: number): void;
  resetStep(stepIndex: number): void;
  setTools(manipulationId: string, values: Values): void;
  addAsset(blob: Blob): Promise<string>;
  loadRecipe(recipe: Recipe, assetBlobs: Record<string, Blob>, warnings: string[]): void;
  dismissWarnings(): void;
}

export function createStep(m: Manipulation, seed = randomSeed()): Step {
  return {
    manipulationId: m.id,
    version: m.version,
    params: m.paramsSchema.parse({}),
    state: m.stateSchema.parse({}),
    seed,
  };
}

const resolve = <T>(update: Updater<T>, prev: T): T =>
  typeof update === 'function' ? (update as (p: T) => T)(prev) : update;

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const useStore = create<AppStore>()((set, get) => {
  const updateStep = (i: number, fn: (step: Step) => Step) =>
    set(({ recipe }) => ({
      recipe: { ...recipe, steps: recipe.steps.map((s, j) => (j === i ? fn(s) : s)) },
    }));

  return {
    recipe: { formatVersion: 1, source: defaultSource, steps: [createStep(MANIPULATIONS[0])], assets: {} },
    assetBlobs: {},
    tools: {},
    warnings: [],

    setSource: (patch) => set(({ recipe }) => ({ recipe: { ...recipe, source: { ...recipe.source, ...patch } } })),

    selectManipulation: (i, id) => updateStep(i, () => createStep(getManipulation(id))),

    setParams: (i, update) => updateStep(i, (s) => ({ ...s, params: resolve(update, s.params) })),

    setState: (i, update) =>
      updateStep(i, (s) => {
        const state = resolve(update, s.state);
        if (import.meta.env.DEV) {
          const check = getManipulation(s.manipulationId).stateSchema.safeParse(state);
          if (!check.success) console.error(`[${s.manipulationId}] invalid State`, check.error.issues, state);
        }
        return { ...s, state };
      }),

    setSeed: (i, seed) => updateStep(i, (s) => ({ ...s, seed })),

    resetStep: (i) => updateStep(i, (s) => createStep(getManipulation(s.manipulationId), s.seed)),

    setTools: (id, values) => set(({ tools }) => ({ tools: { ...tools, [id]: values } })),

    async addAsset(blob) {
      const hash = await sha256(blob);
      if (!get().assetBlobs[hash]) {
        set(({ recipe, assetBlobs }) => ({
          assetBlobs: { ...assetBlobs, [hash]: blob },
          recipe: { ...recipe, assets: { ...recipe.assets, [hash]: { mime: blob.type || 'application/octet-stream' } } },
        }));
      }
      return hash;
    },

    loadRecipe: (recipe, assetBlobs, warnings) => set({ recipe, assetBlobs, warnings }),

    dismissWarnings: () => set({ warnings: [] }),
  };
});
