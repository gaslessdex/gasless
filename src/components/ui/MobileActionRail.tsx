import type { Feature } from '../../types/app';

const ACTIONS: Array<{ id: Feature; label: string }> = [
  { id: 'claim', label: 'CLAIM SOL' },
  { id: 'swap', label: 'GASLESS SWAP' },
  { id: 'send', label: 'GASLESS SEND' },
];

export function MobileActionRail({ onSelect }: { onSelect: (feature: Feature, trigger: HTMLButtonElement) => void }) {
  return <nav className="mobile-action-rail" aria-label="Primary GASLESS actions">
    {ACTIONS.map((action) => <button key={action.id} id={`mobile-action-${action.id}`} type="button" onClick={(event) => onSelect(action.id, event.currentTarget)}>{action.label}</button>)}
  </nav>;
}
