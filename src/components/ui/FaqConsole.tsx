import { useEffect, useRef } from 'react';

const FAQ_ITEMS = [
  ['How does GASLESS work?', 'GASLESS prepares an exact Solana transaction and sponsors the network cost after the transaction passes its safety checks.'],
  ['Do I need SOL?', 'Supported actions are designed to work even when your connected wallet has 0 SOL.'],
  ['Which assets are supported?', 'Only assets in the curated GASLESS token registry are eligible. Live availability can change as safety and liquidity conditions change.'],
  ['Is GASLESS custodial?', 'No. You review and sign the exact transaction that moves your assets.'],
];

export function FaqConsole({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    dialog.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);

  return <section ref={dialog} className="feature-console faq-console" role="dialog" aria-modal="true" aria-labelledby="faq-title" tabIndex={-1}>
    <header className="console-header">
      <div><span>GASLESS / SUPPORT</span><h2 id="faq-title">FAQ</h2><p>Quick answers about sponsored Solana actions.</p></div>
      <div className="console-controls"><button className="console-close" type="button" onClick={onClose} aria-label="Close FAQ">×</button></div>
    </header>
    <div className="faq-list">
      {FAQ_ITEMS.map(([question, answer], index) => <details key={question} open={index === 0}><summary>{question}<span>+</span></summary><p>{answer}</p></details>)}
    </div>
  </section>;
}
