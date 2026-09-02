export function financialTokenSelectionLocked(state: string) {
  return ['validating', 'preparing', 'awaiting-signature', 'submitting'].includes(state);
}
