import { useMemo } from 'react';
import type { z } from 'zod';
import { describeFields, type AssetRef, type Field, type FieldMeta, type Point, type RandomOrNumber } from '../core/fields';
import { useStore } from '../store/store';
import { Select } from './Select';

type Values = Record<string, unknown>;

interface Props {
  schema: z.ZodObject;
  /** Used in error messages for unsupported fields. */
  owner: string;
  values: Values;
  onChange(next: Values): void;
}

/** Controls generated from a zod object schema (see core/fields.ts). */
export function ControlsPanel({ schema, owner, values, onChange }: Props) {
  const fields = useMemo(() => describeFields(schema, owner), [schema, owner]);
  if (fields.length === 0) return null;
  return (
    <div className="controls">
      {fields.map((field) => (
        <Control
          key={field.key}
          field={field}
          value={values[field.key]}
          onChange={(v) => onChange({ ...values, [field.key]: v })}
        />
      ))}
    </div>
  );
}

function Control({ field, value, onChange }: { field: Field; value: unknown; onChange(v: unknown): void }) {
  const { meta } = field;
  // Holds its own labelled checkbox, so the whole control can't be one label.
  const Wrapper = field.kind === 'randomOrNumber' ? 'div' : 'label';
  return (
    <Wrapper className={`control control-${field.kind}`} title={meta.hint}>
      <span className="control-label muted">{field.label}</span>
      {field.kind === 'number' && <NumberInput meta={meta} value={value as number} onChange={onChange} />}
      {field.kind === 'randomOrNumber' && (
        <RandomOrNumberControl meta={meta} value={value as RandomOrNumber} onChange={onChange} />
      )}
      {field.kind === 'boolean' && (
        <input className="checkbox" type="checkbox" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} />
      )}
      {field.kind === 'enum' && (
        <Select
          value={value as string}
          options={field.options.map((o) => ({ value: o, label: o }))}
          onChange={onChange}
        />
      )}
      {field.kind === 'color' && (
        <input className="swatch" type="color" value={value as string} onChange={(e) => onChange(e.target.value)} />
      )}
      {field.kind === 'point' && <PointControl value={value as Point} onChange={onChange} />}
      {field.kind === 'image' && <ImageControl value={value as AssetRef | null} onChange={onChange} />}
    </Wrapper>
  );
}

function NumberInput({ meta, value, onChange }: { meta: FieldMeta; value: number; onChange(v: number): void }) {
  return (
    <span className="control-row">
      {meta.min !== undefined && meta.max !== undefined && (
        <input
          className="range"
          type="range"
          min={meta.min}
          max={meta.max}
          step={meta.step}
          value={value}
          onChange={(e) => onChange(e.target.valueAsNumber)}
        />
      )}
      <input
        className="input"
        type="number"
        min={meta.min}
        max={meta.max}
        step={meta.step}
        value={value}
        onChange={(e) => !Number.isNaN(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)}
      />
    </span>
  );
}

/** A "Random" checkbox; when it's off, the number. */
function RandomOrNumberControl({
  meta,
  value,
  onChange,
}: {
  meta: FieldMeta;
  value: RandomOrNumber;
  onChange(v: RandomOrNumber): void;
}) {
  return (
    <>
      <label className="control-row">
        <input
          className="checkbox"
          type="checkbox"
          checked={value.random}
          onChange={(e) => onChange({ ...value, random: e.target.checked })}
        />
        <span className="muted">Random</span>
      </label>
      {!value.random && <NumberInput meta={meta} value={value.value} onChange={(v) => onChange({ ...value, value: v })} />}
    </>
  );
}

function PointControl({ value, onChange }: { value: Point; onChange(v: Point): void }) {
  return (
    <span className="control-row">
      {(['x', 'y'] as const).map((axis) => (
        <input
          className="input"
          key={axis}
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={value[axis]}
          aria-label={axis}
          onChange={(e) => !Number.isNaN(e.target.valueAsNumber) && onChange({ ...value, [axis]: e.target.valueAsNumber })}
        />
      ))}
    </span>
  );
}

function ImageControl({ value, onChange }: { value: AssetRef | null; onChange(v: AssetRef | null): void }) {
  const addAsset = useStore((s) => s.addAsset);
  return (
    <span className="control-row">
      <input
        className="file"
        type="file"
        accept="image/*"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) onChange({ asset: await addAsset(file) });
        }}
      />
      {value && (
        <button type="button" className="btn" onClick={() => onChange(null)}>
          Clear
        </button>
      )}
    </span>
  );
}
