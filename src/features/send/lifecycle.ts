import { evaluateSendWalletGate } from '../../../chains/solana/send/validity.js';
import type { PreparedTransaction } from '../../../shared/transactions/types.js';
import type { SendDiscoveryResult } from '../../../shared/transactions/types.js';
import { quoteIdForPrepare, shouldAcceptQuote, shouldRefreshQuoteAfterPrepareError } from '../swap/quoteLifecycle.js';

export function shouldAcceptSendPreview(activeGeneration: number, responseGeneration: number, signingLocked = false) {
  return shouldAcceptQuote(activeGeneration, responseGeneration, signingLocked);
}

export function quoteIdForSendPrepare(state: string, quoteId: string | undefined, expiresAt: string | undefined, now = Date.now()) {
  return quoteIdForPrepare(state === 'review' ? 'quote-ready' : state, quoteId, expiresAt, now);
}

export function shouldReturnSendToReview(code: string | undefined) {
  return shouldRefreshQuoteAfterPrepareError(code);
}

export function walletGateForSend(prepared: PreparedTransaction | undefined, responseReceivedAt: number, now = Date.now(), currentBlockHeight = prepared?.preparedBlockHeight) {
  return evaluateSendWalletGate(prepared, responseReceivedAt, now, currentBlockHeight);
}

export function canOpenWalletForSend(prepared: PreparedTransaction | undefined, responseReceivedAt: number, now = Date.now(), currentBlockHeight = prepared?.preparedBlockHeight) {
  return walletGateForSend(prepared, responseReceivedAt, now, currentBlockHeight).allowed;
}

export function discoveryReflectsSendSettlement(discovery: SendDiscoveryResult, mint: string, previousBalanceRaw: string) {
  const balance = discovery.tokens.find((token) => token.mint === mint)?.balanceRaw;
  return balance === undefined || BigInt(balance) < BigInt(previousBalanceRaw);
}
