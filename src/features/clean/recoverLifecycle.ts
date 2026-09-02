import type { RecoverQuoteDetails } from '../../../shared/transactions/types.js';

// A fresh executable may proceed without another review only when its guaranteed
// net user outcome is at least as good as the read-only preview's conservative floor.
export function recoverHasEconomicDownside(preview: RecoverQuoteDetails, prepared: RecoverQuoteDetails) {
  if (!preview.minimumUserPayoutLamports || !prepared.minimumUserPayoutLamports) return true;
  return BigInt(prepared.minimumUserPayoutLamports) < BigInt(preview.minimumUserPayoutLamports);
}
