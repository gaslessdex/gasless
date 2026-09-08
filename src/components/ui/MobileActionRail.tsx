import type { Feature } from '../../types/app';

const LABELS: Record<Feature, string> = { claim: 'CLAIM SOL', bridge: 'GASLESS BRIDGE', swap: 'GASLESS SWAP', send: 'GASLESS SEND' };

export function MobileActionRail({ actions, onSelect }: { actions: readonly Feature[]; onSelect: (feature: Feature, trigger: HTMLButtonElement) => void }) {
  return <nav className="mobile-action-rail" aria-label="Primary GASLESS actions">
    {actions.map((action) => <button key={action} id={`mobile-action-${action}`} type="button" onClick={(event) => onSelect(action, event.currentTarget)}>{LABELS[action]}</button>)}
  </nav>;
}
