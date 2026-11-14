import { useMemo } from 'react';
import type { FontRef } from '../core/recipe';
import { FONT_LOADERS } from '../fonts';
import type { FontFamilyOption } from '../fonts/loader';
import { Select } from './Select';

interface Family extends FontFamilyOption {
  loader: string;
  key: string;
}

const sameArgs = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function FontPicker({ value, onChange }: { value: FontRef; onChange(ref: FontRef): void }) {
  const families = useMemo<Family[]>(
    () =>
      FONT_LOADERS.flatMap((loader) =>
        (loader.catalog?.() ?? []).map((f, i) => ({ ...f, loader: loader.id, key: `${loader.id}::${i}` })),
      ),
    [],
  );
  const familyOptions = useMemo(() => {
    const byGroup = new Map<string, Family[]>();
    for (const f of families) byGroup.set(f.group, [...(byGroup.get(f.group) ?? []), f]);
    return [...byGroup].flatMap(([group, fams]) => fams.map((f) => ({ value: f.key, label: f.label, group })));
  }, [families]);

  const current = families.find((f) => f.loader === value.loader && f.variants.some((v) => sameArgs(v.args, value.args)));
  const currentVariant = current?.variants.find((v) => sameArgs(v.args, value.args));

  const pickFamily = (key: string) => {
    const family = families.find((f) => f.key === key)!;
    // Keep the same weight/style when the new family has it; else prefer Regular.
    const variant =
      family.variants.find((v) => v.label === currentVariant?.label) ??
      family.variants.find((v) => /regular/i.test(v.label)) ??
      family.variants[0];
    onChange({ loader: family.loader, args: variant.args });
  };

  return (
    <div className="controls">
      <label className="control">
        <span className="control-label muted">Font</span>
        <Select
          value={current?.key ?? null}
          options={familyOptions}
          onChange={pickFamily}
          placeholder="(unlisted font)"
        />
      </label>
      {current && current.variants.length > 1 && (
        <label className="control">
          <span className="control-label muted">Weight</span>
          <Select
            value={currentVariant?.label ?? null}
            options={current.variants.map((v) => ({ value: v.label, label: v.label }))}
            onChange={(label) =>
              onChange({ loader: current.loader, args: current.variants.find((v) => v.label === label)!.args })
            }
          />
        </label>
      )}
    </div>
  );
}
