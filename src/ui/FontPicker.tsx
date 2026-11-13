import { useMemo } from 'react';
import type { FontRef } from '../core/recipe';
import { FONT_LOADERS } from '../fonts';
import type { FontFamilyOption } from '../fonts/loader';

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
  const groups = useMemo(() => {
    const byGroup = new Map<string, Family[]>();
    for (const f of families) byGroup.set(f.group, [...(byGroup.get(f.group) ?? []), f]);
    return byGroup;
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
        <select className="input" value={current?.key ?? ''} onChange={(e) => pickFamily(e.target.value)}>
          {!current && <option value="">(unlisted font)</option>}
          {[...groups].map(([group, fams]) => (
            <optgroup key={group} label={group}>
              {fams.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {current && current.variants.length > 1 && (
        <label className="control">
          <span className="control-label muted">Weight</span>
          <select
            className="input"
            value={currentVariant?.label}
            onChange={(e) =>
              onChange({ loader: current.loader, args: current.variants.find((v) => v.label === e.target.value)!.args })
            }
          >
            {current.variants.map((v) => (
              <option key={v.label}>{v.label}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
