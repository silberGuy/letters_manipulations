import { create } from 'zustand';
import type { Manipulation, Updater } from '../core/manipulation';
import { remapSteps } from '../core/pipeline';
import { defaultSource, type Recipe, type Source, type Step } from '../core/recipe';
import { remapBetween, type Remap } from '../core/remap';
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
  /** The export menu is open, so the canvas outlines what will be exported. */
  showExportBounds: boolean;
  /**
   * The Source whose image the Steps' State positions are in. Lags behind
   * recipe.source while a new Source is laid out; applyRemap catches it up.
   */
  anchoredTo: Source;

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
  setShowExportBounds(show: boolean): void;
  /**
   * Move every Step's State from `from` to `to`, if State is still anchored to
   * `from`. Remaps the latest State, so effects added meanwhile move too.
   */
  applyRemap(from: Source, to: Source, remap: Remap): void;
  /** Bring State up to date with the Source (before saving or exporting). */
  reconcile(): Promise<Recipe>;
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
    showExportBounds: false,
    anchoredTo: defaultSource,

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

    loadRecipe: (recipe, assetBlobs, warnings) => set({ recipe, assetBlobs, warnings, anchoredTo: recipe.source }),

    dismissWarnings: () => set({ warnings: [] }),

    setShowExportBounds: (showExportBounds) => set({ showExportBounds }),

    applyRemap: (from, to, remap) =>
      set(({ recipe, anchoredTo }) =>
        anchoredTo === from ? { anchoredTo: to, recipe: { ...recipe, steps: remapSteps(recipe.steps, remap) } } : {},
      ),

    async reconcile() {
      // Loop in case the Source changes again while it's being laid out.
      for (;;) {
        const { recipe, anchoredTo } = get();
        const remap = await remapBetween(anchoredTo, recipe.source);
        if (!remap) return get().recipe;
        get().applyRemap(anchoredTo, recipe.source, remap);
      }
    },
  };
});
