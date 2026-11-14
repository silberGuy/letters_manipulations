import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption {
  value: string;
  label: string;
  /** Consecutive options with the same group are listed under one heading. */
  group?: string;
  /** Shown at the end of the option in the open list (not on the trigger). */
  preview?: ReactNode;
}

interface Props {
  value: string | null;
  options: SelectOption[];
  onChange(value: string): void;
  /** Shown on the trigger when no option matches `value`. */
  placeholder?: string;
  title?: string;
  'aria-label'?: string;
  /** Extra classes for the trigger. */
  className?: string;
  /**
   * Custom trigger content. When given, the trigger drops the field styling
   * and shows this instead of the selected label (e.g. a "+" button).
   */
  trigger?: ReactNode;
}

const GAP = 4;

/**
 * A dropdown with our own menu instead of the browser's, so it can be styled.
 * The menu is portaled to <body> with fixed positioning, so scrolling or
 * clipping containers around the trigger never cut it off.
 */
export function Select({ value, options, onChange, placeholder, title, className, trigger, ...rest }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; minWidth: number; maxHeight: number }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const selectedIndex = options.findIndex((o) => o.value === value);

  const show = () => {
    setActive(Math.max(0, selectedIndex));
    setOpen(true);
  };
  const pick = (i: number) => {
    setOpen(false);
    if (options[i] && options[i].value !== value) onChange(options[i].value);
  };

  // Place the menu below the trigger, or above it when there's more room there.
  useLayoutEffect(() => {
    if (!open) return;
    const r = triggerRef.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP * 2;
    const above = r.top - GAP * 2;
    const left = Math.min(r.left, window.innerWidth - r.width - GAP);
    setPos(
      below >= 200 || below >= above
        ? { left, top: r.bottom + GAP, minWidth: r.width, maxHeight: below }
        : { left, bottom: window.innerHeight - r.top + GAP, minWidth: r.width, maxHeight: above },
    );
  }, [open]);

  // Close on outside press, outside scroll, or resize.
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // Keep the active option in view while moving with the keyboard.
  useEffect(() => {
    if (open) menuRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, pos]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    const last = options.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(last, active + 1),
      ArrowUp: () => Math.max(0, active - 1),
      Home: () => 0,
      End: () => last,
    };
    if (moves[e.key]) {
      e.preventDefault();
      setActive(moves[e.key]());
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const items: ReactNode[] = [];
  options.forEach((o, i) => {
    if (o.group && o.group !== options[i - 1]?.group) {
      items.push(
        <li key={`group:${o.group}`} className="select-group label muted" role="presentation">
          {o.group}
        </li>,
      );
    }
    items.push(
      <li
        key={o.value}
        id={`${id}-${i}`}
        data-index={i}
        role="option"
        aria-selected={i === selectedIndex}
        className={`select-option${i === active ? ' active' : ''}${i === selectedIndex ? ' selected' : ''}`}
        onPointerEnter={() => setActive(i)}
        onClick={() => pick(i)}
      >
        <span className="select-option-label">{o.label}</span>
        {o.preview}
      </li>,
    );
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${trigger ? 'select-custom' : 'input select-trigger'}${className ? ` ${className}` : ''}`}
        title={title}
        aria-label={rest['aria-label']}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        {trigger ?? <span className="select-value">{options[selectedIndex]?.label ?? placeholder ?? ''}</span>}
      </button>
      {open &&
        createPortal(
          <ul
            ref={menuRef}
            id={`${id}-menu`}
            role="listbox"
            className="select-menu"
            style={pos ? { ...pos } : { visibility: 'hidden' }}
          >
            {items}
          </ul>,
          document.body,
        )}
    </>
  );
}
