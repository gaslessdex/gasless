import { useEffect, useRef, useState } from 'react';

export type TokenOption = { id?: string; mint: string; program: string; symbol: string; name: string; balance?: string; eligible: boolean };

export function TokenSelector({ label, value, tokens, onChange, disabled = false }: { label: string; value: TokenOption | null; tokens: TokenOption[]; onChange: (token: TokenOption) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const filtered = tokens.filter((token) => `${token.symbol} ${token.name} ${token.mint}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { if (open) dialog.current?.querySelector<HTMLInputElement>('input')?.focus(); }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div className="token-control">
    <button className="token-trigger" type="button" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}><span>{label}</span><strong>{value?.symbol ?? 'SELECT TOKEN'}</strong><i aria-hidden="true">⌄</i></button>
    {open && <div className="token-picker-scrim" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="token-picker" ref={dialog} role="dialog" aria-modal="true" aria-label={`${label} token`}>
        <header><div><small>ASSET DIRECTORY</small><h3>Select token</h3></div><button type="button" aria-label="Close token selector" onClick={() => setOpen(false)}>×</button></header>
        <label className="token-search"><span>SEARCH</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Symbol, name, or mint" /></label>
        <div className="token-list" role="listbox">
          {filtered.length ? filtered.map((token) => <button key={token.id ?? `${token.program}:${token.mint}`} type="button" role="option" aria-selected={(value?.id ?? value?.mint) === (token.id ?? token.mint)} disabled={!token.eligible} onClick={() => { onChange(token); setOpen(false); setQuery(''); }}><i aria-hidden="true">{token.symbol.slice(0, 1)}</i><span><strong>{token.symbol}</strong><small>{token.name}</small></span><span><strong>{token.balance ?? '—'}</strong><small>{token.eligible ? 'AVAILABLE' : 'UNSUPPORTED'}</small></span></button>) : <p className="token-empty">Connect a wallet to load eligible token balances.</p>}
        </div>
      </div>
    </div>}
  </div>;
}

export function GaslessStatus({ connected }: { connected: boolean }) { return <div className={`gasless-status${connected ? ' is-available' : ''}`}><i aria-hidden="true" /><span>WALLET CONNECTION</span><strong>{connected ? 'READY' : 'WALLET REQUIRED'}</strong></div>; }
export function FieldError({ id, children }: { id: string; children?: string }) { return children ? <p className="field-error" id={id} role="alert">{children}</p> : null; }
export function DetailSection({ children }: { children: React.ReactNode }) { return <details className="advanced-details"><summary>FEES &amp; DETAILS <span aria-hidden="true">＋</span></summary><div className="detail-content">{children}</div></details>; }
export function DetailRow({ label, value }: { label: string; value: string }) { return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>; }
