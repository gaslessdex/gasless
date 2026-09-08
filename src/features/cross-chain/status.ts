import type { CrossChainStatus } from '../../../shared/cross-chain/types.js';

export type CrossChainUiStatus = CrossChainStatus | 'sending';

export function crossChainStatusPresentation(status: CrossChainUiStatus) {
  switch (status) {
    case 'preparing': return { label: 'PREPARING', message: 'Securing the route and checking the transaction.', terminal: false };
    case 'awaiting_signature': return { label: 'WAITING FOR SIGNATURE', message: 'Review and approve the exact transaction in your wallet.', terminal: false };
    case 'sending': return { label: 'SENDING', message: 'Submitting the signed transaction to Solana.', terminal: false };
    case 'submitted':
    case 'source_confirmed':
    case 'executing': return { label: 'BRIDGING', message: 'Your source transaction is confirmed and the bridge is working.', terminal: false };
    case 'destination_confirmed': return { label: 'ARRIVING', message: 'The destination transaction is confirming.', terminal: false };
    case 'completed': return { label: 'COMPLETE', message: 'Your assets arrived on Robinhood Chain.', terminal: true };
    case 'refund_pending': return { label: 'REFUND PENDING', message: 'The route could not complete. Your refund is being processed.', terminal: false };
    case 'refunded': return { label: 'TRANSACTION FAILED', message: 'The route did not complete and your source funds were refunded.', terminal: true };
    case 'unknown_retryable': return { label: 'BRIDGE DELAYED', message: 'The bridge is taking longer than expected. You can safely keep waiting.', terminal: false };
    default: return { label: 'TRANSACTION FAILED', message: 'The transaction did not complete. No second transaction will be sent.', terminal: true };
  }
}

export function crossChainFailurePresentation(code?: string) {
  if (code === 'QUOTE_EXPIRED' || code === 'QUOTE_NOT_FOUND') return { label: 'QUOTE EXPIRED', message: 'Request a fresh quote and try again.' };
  if (code === 'ROUTE_UNAVAILABLE' || code === 'TOKEN_UNSUPPORTED' || code === 'UNSUPPORTED_ROUTE') return { label: 'ROUTE UNAVAILABLE', message: 'This route is not available right now. Try again later.' };
  if (code === 'ACTION_DISABLED') return { label: 'TRANSACTION FAILED', message: 'Cross-chain execution is currently limited to private testing.' };
  return { label: 'TRANSACTION FAILED', message: 'The transaction did not complete. Review the details and try again.' };
}
