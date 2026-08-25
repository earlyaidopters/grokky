import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";

export interface SelectChoice<T extends string | number> {
  value: T;
  label: string;
  detail?: string;
}

export function SelectMenu<T extends string | number>({
  value,
  choices,
  label,
  disabled,
  compact,
  onChange,
}: {
  value: T;
  choices: Array<SelectChoice<T>>;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  onChange(value: T): void;
}) {
  const [open, setOpen] = useState(false);
  const [opensUp, setOpensUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();
  const selected = choices.find((choice) => choice.value === value) ?? choices[0];

  useEffect(() => {
    if (!open) return;
    const closeOnPointerAway = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointerAway);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerAway);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = Math.max(0, choices.findIndex((choice) => choice.value === value));
    requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
  }, [choices, open, value]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    setOpensUp(Boolean(rect && window.innerHeight - rect.bottom < 270 && rect.top > 270));
    setOpen(true);
  };

  return (
    <div className={`select-menu ${compact ? "compact" : ""} ${open ? "open" : ""} ${opensUp ? "opens-up" : ""}`} ref={rootRef}>
      <button
        ref={buttonRef}
        className="select-menu-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
      >
        <span>{selected?.label ?? String(value)}</span>
        <CaretDown size={13} weight="bold" />
      </button>
      {open && (
        <div className="select-menu-popover" id={listId} role="listbox" aria-label={label}>
          {choices.map((choice) => {
            const active = choice.value === value;
            return (
              <button
                key={String(choice.value)}
                ref={(node) => { optionRefs.current[choices.indexOf(choice)] = node; }}
                type="button"
                role="option"
                aria-selected={active}
                className={active ? "selected" : ""}
                onClick={() => {
                  onChange(choice.value);
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                onKeyDown={(event) => {
                  const currentIndex = choices.indexOf(choice);
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const direction = event.key === "ArrowDown" ? 1 : -1;
                    const nextIndex = (currentIndex + direction + choices.length) % choices.length;
                    optionRefs.current[nextIndex]?.focus();
                  }
                  if (event.key === "Home") { event.preventDefault(); optionRefs.current[0]?.focus(); }
                  if (event.key === "End") { event.preventDefault(); optionRefs.current[choices.length - 1]?.focus(); }
                }}
              >
                <span><strong>{choice.label}</strong>{choice.detail && <small>{choice.detail}</small>}</span>
                {active && <Check size={14} weight="bold" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ModelCombobox({
  value,
  suggestions,
  label,
  disabled,
  onCommit,
}: {
  value: string;
  suggestions: string[];
  label: string;
  disabled?: boolean;
  onCommit(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [opensUp, setOpensUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const filtered = useMemo(() => {
    const query = draft.trim().toLowerCase();
    if (!query) return suggestions;
    return suggestions.filter((suggestion) => suggestion.toLowerCase().includes(query));
  }, [draft, suggestions]);

  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target)) return;
      setOpen(false);
      setDraft(value);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, value]);

  const commit = (nextValue = draft) => {
    const next = nextValue.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
    setOpen(false);
  };

  return (
    <div className={`model-combobox ${open ? "open" : ""} ${opensUp ? "opens-up" : ""}`} ref={rootRef}>
      <input
        ref={inputRef}
        value={draft}
        disabled={disabled}
        aria-label={label}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        role="combobox"
        onFocus={() => {
          const rect = inputRef.current?.getBoundingClientRect();
          setOpensUp(Boolean(rect && window.innerHeight - rect.bottom < 300 && rect.top > 300));
          setOpen(true);
        }}
        onChange={(event) => { setDraft(event.target.value); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); }
          if (event.key === "Escape") { setDraft(value); setOpen(false); inputRef.current?.blur(); }
        }}
      />
      <CaretDown size={13} weight="bold" aria-hidden="true" />
      {open && (
        <div className="model-combobox-popover" id={listId} role="listbox" aria-label="Suggested models">
          <div className="model-search-label"><MagnifyingGlass size={13} />Choose a model or enter its OpenRouter ID</div>
          {filtered.slice(0, 8).map((suggestion) => (
            <button key={suggestion} type="button" role="option" aria-selected={suggestion === value} onClick={() => { setDraft(suggestion); commit(suggestion); }}>
              <span>{suggestion}</span>
              {suggestion === value && <Check size={14} weight="bold" />}
            </button>
          ))}
          {!filtered.length && <div className="model-combobox-empty">Press Enter to use “{draft.trim()}”</div>}
        </div>
      )}
    </div>
  );
}
