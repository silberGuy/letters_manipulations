import { useEffect, useMemo, useRef, useState } from 'react';
import type { FontRef } from '../core/recipe';
import { FONT_LOADERS, loadFont } from '../fonts';
import type { FontFamilyOption, LoadedFont } from '../fonts/loader';
import { Select } from './Select';

interface Family extends FontFamilyOption {
  loader: string;
  key: string;
}

const sameArgs = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const SAMPLE_LETTERS = 4;

/** The first few letters of the Source text, for previewing fonts. */
function sampleOf(text: string): string {
  const letters = Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, SAMPLE_LETTERS).join('');
  return letters || 'Aa';
}

/** `text` drawn in `font`. Loads the font only once the sample scrolls into view. */
function FontSample({ font, text }: { font: FontRef; text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [loaded, setLoaded] = useState<LoadedFont | null>(null);
  const key = JSON.stringify([font, text]);

  useEffect(() => {
    let cancelled = false;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      loadFont(font, text).then(
        (f) => !cancelled && setLoaded(f),
        () => {}, // No preview if it fails; picking the font will surface the error.
      );
    });
    io.observe(ref.current!);
    return () => {
      cancelled = true;
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <span
      ref={ref}
      className="font-sample"
      dir="auto"
      style={
        loaded
          ? { fontFamily: `"${loaded.cssFamily}"`, fontWeight: loaded.weight, fontStyle: loaded.style }
          : { visibility: 'hidden' }
      }
    >
      {text}
    </span>
  );
}

export function FontPicker({
  value,
  onChange,
  sampleText,
}: {
  value: FontRef;
  onChange(ref: FontRef): void;
  /** The Source text; its first letters preview each font in the list. */
  sampleText: string;
}) {
  const families = useMemo<Family[]>(
    () =>
      FONT_LOADERS.flatMap((loader) =>
        (loader.catalog?.() ?? []).map((f, i) => ({ ...f, loader: loader.id, key: `${loader.id}::${i}` })),
      ),
    [],
  );
  const current = families.find((f) => f.loader === value.loader && f.variants.some((v) => sameArgs(v.args, value.args)));
  const currentVariant = current?.variants.find((v) => sameArgs(v.args, value.args));

  // The variant picking `family` would give: the same weight/style when it has it, else Regular.
  const variantFor = (family: Family) =>
    family.variants.find((v) => v.label === currentVariant?.label) ??
    family.variants.find((v) => /regular/i.test(v.label)) ??
    family.variants[0];

  const sample = sampleOf(sampleText);
  const familyOptions = useMemo(() => {
    const byGroup = new Map<string, Family[]>();
    for (const f of families) byGroup.set(f.group, [...(byGroup.get(f.group) ?? []), f]);
    return [...byGroup].flatMap(([group, fams]) =>
      fams.map((f) => ({
        value: f.key,
        label: f.label,
        group,
        preview: <FontSample font={{ loader: f.loader, args: variantFor(f).args }} text={sample} />,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [families, sample, currentVariant?.label]);

  const pickFamily = (key: string) => {
    const family = families.find((f) => f.key === key)!;
    onChange({ loader: family.loader, args: variantFor(family).args });
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
