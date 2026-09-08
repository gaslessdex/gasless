import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { searchSolanaTokens, shortSolanaMint } from '../../../chains/solana/token-registry/types';

export type TokenOption = { id?: string; mint: string; program: string; symbol: string; name: string; image?: string; balance?: string; eligible: boolean };

function TokenImage({ token }: { token: TokenOption }) {
  return <img src={token.image ?? '/favicon.svg'} alt="" loading="lazy" width="36" height="36" onError={(event) => { if (!event.currentTarget.src.endsWith('/favicon.svg')) event.currentTarget.src = '/favicon.svg'; }} />;
}

export function TokenSelector({ label, value, tokens, onChange, disabled = false }: { label: string; value: TokenOption | null; tokens: TokenOption[]; onChange: (token: TokenOption) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filtered = useMemo(() => searchSolanaTokens(tokens, query), [query, tokens]);
  const close = (restoreFocus = false) => { setOpen(false); setQuery(''); if (restoreFocus) window.requestAnimationFrame(() => trigger.current?.focus()); };
  const focusOption = (index: number) => optionRefs.current[index]?.focus();
  useEffect(() => { if (open) dialog.current?.querySelector<HTMLInputElement>('input')?.focus(); }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setQuery(''); window.requestAnimationFrame(() => trigger.current?.focus()); } };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
  const handleListKey = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); focusOption((index + 1) % filtered.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusOption((index - 1 + filtered.length) % filtered.length); }
    else if (event.key === 'Home') { event.preventDefault(); focusOption(0); }
    else if (event.key === 'End') { event.preventDefault(); focusOption(filtered.length - 1); }
  };
  return <div className="token-control">
    <button ref={trigger} className="token-trigger" type="button" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}><span>{label}</span><strong>{value?.symbol ?? 'SELECT TOKEN'}</strong><i aria-hidden="true">⌄</i></button>
    {open && <div className="token-picker-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="token-picker" ref={dialog} role="dialog" aria-modal="true" aria-label={`${label} token`}>
        <header><div><small>ASSET DIRECTORY</small><h3>Select token</h3></div><button type="button" aria-label="Close token selector" onClick={() => close(true)}>×</button></header>
        <label className="token-search"><span>SEARCH</span><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'ArrowDown' && filtered.length) { event.preventDefault(); focusOption(0); } else if (event.key === 'ArrowUp' && filtered.length) { event.preventDefault(); focusOption(filtered.length - 1); } }} placeholder="Search by name, symbol, or mint address" /></label>
        <div className="token-list" role="listbox">
          {filtered.length ? filtered.map((token, index) => <button ref={(node) => { optionRefs.current[index] = node; }} key={token.id ?? `${token.program}:${token.mint}`} type="button" role="option" aria-selected={(value?.id ?? value?.mint) === (token.id ?? token.mint)} disabled={!token.eligible} onKeyDown={(event) => handleListKey(event, index)} onClick={() => { onChange(token); close(true); }}><TokenImage token={token} /><span><strong>{token.symbol}</strong><small>{token.name}</small><small className="token-mint">{shortSolanaMint(token.mint)}</small></span><span><strong>{token.balance ?? '—'}</strong><small>{token.eligible ? 'AVAILABLE' : 'UNSUPPORTED'}</small></span></button>) : <p className="token-empty">{query.trim() ? `No tokens match “${query.trim()}”.` : 'Connect a wallet to load eligible token balances.'}</p>}
        </div>
      </div>
    </div>}
  </div>;
}

export function ChoiceSelect({ id, label, value, options, onChange, disabled = false }: { id: string; label: string; value: number; options: ReadonlyArray<{ value: number; label: string }>; onChange: (value: number) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) window.requestAnimationFrame(() => trigger.current?.focus()); };
  const focusOption = (index: number) => window.requestAnimationFrame(() => optionRefs.current[index]?.focus());
  const openAt = (index: number) => { setOpen(true); focusOption(index); };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!control.current?.contains(event.target as Node)) setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); window.requestAnimationFrame(() => trigger.current?.focus()); } };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const handleListKey = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); focusOption((index + 1) % options.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusOption((index - 1 + options.length) % options.length); }
    else if (event.key === 'Home') { event.preventDefault(); focusOption(0); }
    else if (event.key === 'End') { event.preventDefault(); focusOption(options.length - 1); }
  };

  return <div className="choice-select" ref={control}>
    <label htmlFor={id}>{label}</label>
    <button ref={trigger} id={id} className="choice-select__trigger" type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId} disabled={disabled} onClick={() => open ? close() : openAt(selectedIndex)} onKeyDown={(event) => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); openAt(event.key === 'ArrowUp' ? options.length - 1 : selectedIndex); } }}>{options[selectedIndex]?.label}<i aria-hidden="true">⌄</i></button>
    {open && <div id={listboxId} className="choice-select__menu" role="listbox" aria-label={label}>
      {options.map((option, index) => <button ref={(node) => { optionRefs.current[index] = node; }} key={option.value} type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'is-selected' : ''} onKeyDown={(event) => handleListKey(event, index)} onClick={() => { onChange(option.value); close(true); }}><span>{option.label}</span><i aria-hidden="true">{option.value === value ? '✓' : ''}</i></button>)}
    </div>}
  </div>;
}

export function GaslessStatus({ connected }: { connected: boolean }) { return <div className={`gasless-status${connected ? ' is-available' : ''}`}><i aria-hidden="true" /><span>WALLET CONNECTION</span><strong>{connected ? 'READY' : 'WALLET REQUIRED'}</strong></div>; }
export function FieldError({ id, children }: { id: string; children?: string }) { return children ? <p className="field-error" id={id} role="alert">{children}</p> : null; }
export function DetailSection({ children }: { children: React.ReactNode }) { return <details className="advanced-details"><summary>FEES &amp; DETAILS <span aria-hidden="true" /></summary><div className="detail-content">{children}</div></details>; }
export function DetailRow({ label, value }: { label: string; value: string }) { return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>; }
