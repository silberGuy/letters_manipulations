import { z } from 'zod';

/**
 * Schema helpers for Params and Tool settings. Every field carries UI hints in
 * zod `.meta()`, and `describeFields` turns an object schema into a list of
 * controls. Every field must have a default, so `schema.parse({})` yields the
 * initial values.
 */

export type Widget = 'color' | 'point' | 'image';

export interface FieldMeta {
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  widget?: Widget;
  hint?: string;
}

export function numberField(o: {
  label: string;
  min: number;
  max: number;
  step?: number;
  default: number;
  hint?: string;
}) {
  return z
    .number()
    .min(o.min)
    .max(o.max)
    .default(o.default)
    .meta({ label: o.label, min: o.min, max: o.max, step: o.step ?? 1, hint: o.hint });
}

export function booleanField(o: { label: string; default: boolean }) {
  return z.boolean().default(o.default).meta({ label: o.label });
}

export function enumField<const T extends readonly [string, ...string[]]>(
  values: T,
  o: { label: string; default: T[number] },
) {
  return z.enum(values).default(o.default as never).meta({ label: o.label });
}

export function colorField(o: { label: string; default: string }) {
  return z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default(o.default)
    .meta({ label: o.label, widget: 'color' });
}

/** A point in normalized (0..1) coordinates of the Step's input. */
export const pointSchema = z.object({ x: z.number(), y: z.number() });
export type Point = z.output<typeof pointSchema>;

export function pointField(o: { label: string; default: Point }) {
  return pointSchema.default(o.default).meta({ label: o.label, widget: 'point' });
}

/** Reference to an Asset in the Recipe, by content hash. */
export const assetRefSchema = z.object({ asset: z.string() });
export type AssetRef = z.output<typeof assetRefSchema>;

export function imageField(o: { label: string }) {
  return assetRefSchema.nullable().default(null).meta({ label: o.label, widget: 'image' });
}

// ---------------------------------------------------------------------------

export type FieldKind = 'number' | 'boolean' | 'enum' | 'color' | 'point' | 'image';

export interface Field {
  key: string;
  kind: FieldKind;
  label: string;
  meta: FieldMeta;
  options: string[];
}

interface Def {
  type: string;
  innerType?: z.ZodType;
  entries?: Record<string, string>;
}

const WRAPPERS = new Set(['default', 'prefault', 'optional', 'nullable', 'readonly', 'catch']);

function defOf(schema: z.ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

/**
 * Describe the controls for an object schema. Throws on unsupported field
 * types so a broken Manipulation fails loudly at startup.
 */
export function describeFields(schema: z.ZodObject, owner: string): Field[] {
  return Object.entries(schema.shape).map(([key, fieldSchema]) => {
    let s = fieldSchema as unknown as z.ZodType;
    let meta: FieldMeta = {};
    // Walk wrappers outside-in; outer meta wins.
    for (;;) {
      meta = { ...(z.globalRegistry.get(s) as FieldMeta | undefined), ...meta };
      const d = defOf(s);
      if (WRAPPERS.has(d.type) && d.innerType) s = d.innerType;
      else break;
    }
    const d = defOf(s);
    const field = (kind: FieldKind, options: string[] = []): Field => ({
      key,
      kind,
      label: meta.label ?? key,
      meta,
      options,
    });

    if (d.type === 'number') return field('number');
    if (d.type === 'boolean') return field('boolean');
    if (d.type === 'enum') return field('enum', Object.values(d.entries ?? {}));
    if (d.type === 'string' && meta.widget === 'color') return field('color');
    if (d.type === 'object' && meta.widget === 'point') return field('point');
    if (d.type === 'object' && meta.widget === 'image') return field('image');
    throw new Error(
      `${owner}: field "${key}" has unsupported type "${d.type}"` +
        (meta.widget ? ` with widget "${meta.widget}"` : ''),
    );
  });
}
