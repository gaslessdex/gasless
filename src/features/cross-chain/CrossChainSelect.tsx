import { useEffect, useId, useRef, useState } from 'react';
import { nextEnabledOption, type SelectOption } from './selectorNavigation';

export function CrossChainSelect<T extends string>({ id, label, value, options, onChange, className = '', disabled = false }: { id: string; label: string; value: T; options: ReadonlyArray<SelectOption<T>>; onChange: (value: T) => void; className?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) window.requestAnimationFrame(() => trigger.current?.focus()); };
  const focusOption = (index: number) => { if (index >= 0) window.requestAnimationFrame(() => optionRefs.current[index]?.focus()); };
  const openAt = (index: number) => { if (disabled) return; setOpen(true); focusOption(options[index]?.disabled ? nextEnabledOption(options, index, 1) : index); };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);

  const handleListKey = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focusOption(nextEnabledOption(options, index, event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); const edge = event.key === 'Home' ? -1 : 0; focusOption(nextEnabledOption(options, edge, event.key === 'Home' ? 1 : -1)); }
    else if (event.key === 'Tab') setOpen(false);
  };

  return <div className={`cross-chain-select ${className}`.trim()} ref={root}>
    <button ref={trigger} id={id} className="cross-chain-select__trigger" type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId} disabled={disabled} onClick={() => open ? close() : openAt(selectedIndex)} onKeyDown={(event) => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); const index = nextEnabledOption(options, selectedIndex, event.key === 'ArrowDown' ? 1 : -1); openAt(index); } }}><strong>{selected?.label}</strong><i aria-hidden="true">⌄</i></button>
    {open && <div id={listboxId} className="cross-chain-select__menu" role="listbox" aria-label={label} onKeyDownCapture={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }}>
      {options.map((option, index) => <button ref={(node) => { optionRefs.current[index] = node; }} key={option.value} type="button" role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} disabled={option.disabled} className={option.value === value ? 'is-selected' : ''} onKeyDown={(event) => handleListKey(event, index)} onClick={() => { if (!option.disabled) onChange(option.value); close(true); }}><span>{option.label}</span><i aria-hidden="true">{option.value === value ? '✓' : ''}</i></button>)}
    </div>}
  </div>;
}
