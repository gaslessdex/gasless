import { useEffect, useRef } from 'react';

const FAQ_ITEMS = [
  ['What is GASLESS?', 'GASLESS helps people clean, move, swap, and bridge supported assets without first acquiring a separate gas-token balance for eligible actions. Solana offers Clean, Swap, Send, and sponsored origin execution for supported cross-chain routes.'],
  ['Do I need SOL, ETH, BNB, or another gas token?', 'For a supported gasless action, GASLESS is designed to sponsor the required network cost. Availability still depends on the selected network, asset, action, and current service status.'],
  ['How does GASLESS work?', 'GASLESS prepares a supported transaction, checks it against its safety rules, shows the expected result, and asks you to approve the asset action. GASLESS handles the network fee for eligible transactions.'],
  ['What can I do on GASLESS?', 'On Solana you can clean eligible token accounts, recover eligible value, burn unwanted eligible tokens, swap supported assets, send supported assets, and use current Relay routes to Robinhood Chain. Native Robinhood, Base, and BNB workflows remain previews.'],
  ['Which networks are supported?', 'Solana is the active execution network. Robinhood Chain is an active destination for supported Solana-origin routes, while native Robinhood-origin execution remains a preview. Base and BNB Chain are planned.'],
  ['Which tokens are supported?', 'Token availability is curated separately for each network and action. It may change with liquidity, token behavior, safety controls, and service availability. Solana Clean eligibility is separate from the Swap and Send token registry.'],
  ['Does GASLESS hold my assets?', 'GASLESS is designed as a non-custodial interface. You review and authorize transactions that act on your connected wallet.'],
  ['What fees does GASLESS charge?', 'Fee models vary by action. Before you sign, the transaction preview shows the applicable costs and what you are expected to pay or receive.'],
  ['Why can an action be unavailable?', 'A network may not be active yet, an asset may be unsupported, sponsorship may be paused, or current routing, liquidity, safety, wallet, or network conditions may not qualify.'],
  ['Are EVM networks live?', 'Robinhood Chain can receive supported Solana-origin cross-chain execution where a current route is available. Native EVM-origin transaction execution and EVM wallet connections are not active yet; Base and BNB Chain remain planned.'],
  ['Will GASLESS add more networks?', 'GASLESS uses a common multichain interface so additional networks can be integrated later without changing the basic experience. No networks beyond the four shown are currently promised.'],
];

export function FaqConsole({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = dialog.current;
    node?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return <section ref={dialog} className="feature-console faq-console" role="dialog" aria-modal="true" aria-labelledby="faq-title" tabIndex={-1}>
    <header className="console-header">
      <div><h2 id="faq-title">FAQ</h2><p>Quick answers about gasless asset management.</p></div>
      <div className="console-controls"><button className="console-close" type="button" onClick={onClose} aria-label="Close FAQ">×</button></div>
    </header>
    <div className="faq-list">
      {FAQ_ITEMS.map(([question, answer], index) => <details key={question} open={index === 0}><summary>{question}<span aria-hidden="true" /></summary><p>{answer}</p></details>)}
    </div>
    <section className="faq-legal" aria-labelledby="legal-title"><h3 id="legal-title">LEGAL &amp; PRIVACY</h3><p>GASLESS is software for interacting with supported blockchain networks and third-party liquidity or routing infrastructure. Transactions involve blockchain and market risks and may be irreversible. Always review transaction details before approving them. GASLESS does not provide investment, legal, or tax advice.</p><p>GASLESS does not require a user account or collect profile information to use the app. Wallet addresses and transaction metadata may be processed where necessary for transaction execution, security, reconciliation, abuse prevention, and aggregate service statistics.</p></section>
  </section>;
}
