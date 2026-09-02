type SendError = { code?: string; message?: string };

export function sendErrorMessage(error: SendError, phase: 'review' | 'prepare' | 'wallet' | 'submit') {
  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();
  if (code === 'USER_EXPLICITLY_CANCELLED') return 'Transaction cancelled in your wallet. Nothing was sent.';
  if (code === 'WALLET_SIGNING_TIMEOUT') return 'Wallet approval timed out. Nothing was sent. Review the Send and try again.';
  if (code === 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN') return 'Transaction expired while awaiting wallet approval. Nothing was sent. Review the updated costs and try again.';
  if (code === 'WALLET_PROVIDER_ERROR' || code === 'UNKNOWN_WALLET_FAILURE') return 'Your wallet could not complete the approval. Nothing was sent.';
  if (code === 'APP_ABORTED_SIGNING_FLOW') return 'Wallet approval was interrupted. Nothing was sent. Review the Send and try again.';
  if (code === 'WALLET_ACCOUNT_CHANGED') return 'The connected wallet changed before this Send could continue. Nothing was sent. Review the Send again.';
  if (code === 'SESSION_DISCONNECTED') return 'The wallet disconnected before this Send could continue. Nothing was sent. Reconnect and review the Send again.';
  if (code === 'MESSAGE_MISMATCH') return 'The recipient setup changed before signing. Nothing was sent. Review the Send again.';
  if (code === 'PREPARATION_EXPIRED_BEFORE_WALLET') return 'Send preparation expired before wallet approval. Review the updated costs and try again.';
  if (['QUOTE_NOT_FOUND', 'QUOTE_EXPIRED', 'QUOTE_ALREADY_USED'].includes(code)) return phase === 'review' ? 'Your Send preview expired. Review the updated costs and try again.' : 'Send preparation expired before wallet approval. Review the updated costs and try again.';
  if (message.includes('pricing')) return 'Current pricing is temporarily unavailable. Please review this Send again in a moment.';
  if (message.includes('balance') || code === 'INSUFFICIENT_BALANCE') return 'You need a little more of this token. Try a smaller amount or use MAX.';
  if (message.includes('recipient') || message.includes('wallet address')) return 'Enter a valid supported Solana wallet address.';
  if (['TOKEN_UNSUPPORTED', 'TOKEN_PAUSED'].includes(code)) return 'GASLESS Send is temporarily unavailable for this token.';
  if (phase === 'wallet' || (!code && /sign|wallet|approval|cancel/.test(message))) return message.includes('cannot sign') || message.includes('does not support') ? 'This wallet cannot approve this Send.' : 'Your wallet could not complete the approval. Nothing was sent.';
  return 'GASLESS Send is temporarily unavailable. Please try again later.';
}
