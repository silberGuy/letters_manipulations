import { z } from 'zod';
import { enumField, numberField } from './fields';

export const fontRefSchema = z.object({
  /** Id of a registered font loader. */
  loader: z.string(),
  /** Loader-specific, validated by that loader's argsSchema. */
  args: z.unknown(),
});
export type FontRef = z.output<typeof fontRefSchema>;

/** The Source's layout settings — rendered by the generic controls panel. */
export const sourceLayoutSchema = z.object({
  fontSize: numberField({ label: 'Size (px)', min: 8, max: 800, default: 220 }),
  letterSpacing: numberField({ label: 'Letter spacing (px)', min: -100, max: 300, default: 0 }),
  lineHeight: numberField({ label: 'Line height', min: 0.5, max: 3, step: 0.01, default: 1.1 }),
  align: enumField(['start', 'center', 'end'], { label: 'Align', default: 'center' }),
  direction: enumField(['auto', 'rtl', 'ltr'], { label: 'Direction', default: 'auto' }),
  padding: numberField({ label: 'Padding (px)', min: 0, max: 500, default: 60 }),
});

export const sourceSchema = sourceLayoutSchema.extend({
  text: z.string(),
  font: fontRefSchema,
});
export type Source = z.output<typeof sourceSchema>;

export const stepSchema = z.object({
  manipulationId: z.string(),
  version: z.number().int(),
  params: z.record(z.string(), z.unknown()),
  state: z.record(z.string(), z.unknown()),
  seed: z.number().int(),
});
export type Step = z.output<typeof stepSchema>;

export const recipeSchema = z.object({
  formatVersion: z.literal(1),
  source: sourceSchema,
  steps: z.array(stepSchema).min(1),
  /** content hash → metadata; the bytes travel alongside in the saved .zip */
  assets: z.record(z.string(), z.object({ mime: z.string() })),
});
export type Recipe = z.output<typeof recipeSchema>;

export const defaultSource: Source = {
  ...sourceLayoutSchema.parse({}),
  text: 'לטרינג',
  font: { loader: 'google', args: { family: 'Rubik', weight: 700 } },
};
