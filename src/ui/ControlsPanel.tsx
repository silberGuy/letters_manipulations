import { useMemo } from 'react';
import type { z } from 'zod';
import { describeFields, type AssetRef, type Field, type Point } from '../core/fields';
import { useStore } from '../store/store';

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
  return (
    <label className={`control control-${field.kind}`} title={meta.hint}>
      <span className="control-label">{field.label}</span>
      {field.kind === 'number' && (
        <span className="control-row">
          {meta.min !== undefined && meta.max !== undefined && (
            <input
              type="range"
              min={meta.min}
              max={meta.max}
              step={meta.step}
              value={value as number}
              onChange={(e) => onChange(e.target.valueAsNumber)}
            />
          )}
          <input
            type="number"
            min={meta.min}
            max={meta.max}
            step={meta.step}
            value={value as number}
            onChange={(e) => !Number.isNaN(e.target.valueAsNumber) && onChange(e.target.valueAsNumber)}
          />
        </span>
      )}
      {field.kind === 'boolean' && (
        <input type="checkbox" checked={value as boolean} onChange={(e) => onChange(e.target.checked)} />
      )}
      {field.kind === 'enum' && (
        <select value={value as string} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
      {field.kind === 'color' && (
        <input type="color" value={value as string} onChange={(e) => onChange(e.target.value)} />
      )}
      {field.kind === 'point' && <PointControl value={value as Point} onChange={onChange} />}
      {field.kind === 'image' && <ImageControl value={value as AssetRef | null} onChange={onChange} />}
    </label>
  );
}

function PointControl({ value, onChange }: { value: Point; onChange(v: Point): void }) {
  return (
    <span className="control-row">
      {(['x', 'y'] as const).map((axis) => (
        <input
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
        type="file"
        accept="image/*"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) onChange({ asset: await addAsset(file) });
        }}
      />
      {value && (
        <button type="button" onClick={() => onChange(null)}>
          Clear
        </button>
      )}
    </span>
  );
}
