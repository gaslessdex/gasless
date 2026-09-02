import type { PreparedTransaction } from '../../../shared/transactions/types.js';
import { SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN, SWAP_MINIMUM_WALLET_OPEN_WINDOW_MS, SWAP_SUBMISSION_BUFFER_MS, SWAP_WALLET_SIGNING_WINDOW_MS } from '../swap/validity.js';

export const SEND_PREPARED_RESPONSE_ALLOWANCE_MS = 15_000;
export const SEND_POST_SIGNATURE_BLOCK_MARGIN = 30;

export function createSendSigningWindow(lastValidBlockHeight: number, currentBlockHeight: number, now = Date.now()) {
  if (!Number.isSafeInteger(lastValidBlockHeight) || !Number.isSafeInteger(currentBlockHeight) || lastValidBlockHeight - currentBlockHeight < SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN) return null;
  const readyAt = new Date(now).toISOString();
  const walletSigningExpiresAt = new Date(now + SWAP_WALLET_SIGNING_WINDOW_MS + SEND_PREPARED_RESPONSE_ALLOWANCE_MS).toISOString();
  return {
    readyAt,
    walletSigningExpiresAt,
    walletSigningWindowMs: SWAP_WALLET_SIGNING_WINDOW_MS,
    preparedBlockHeight: currentBlockHeight,
    quoteExpiresAt: new Date(Date.parse(walletSigningExpiresAt) + SWAP_SUBMISSION_BUFFER_MS).toISOString(),
  };
}

export type SendWalletGateReason = 'safe' | 'invalid_preparation' | 'blockhash_margin' | 'wallet_deadline';

export function evaluateSendWalletGate(prepared: PreparedTransaction | undefined, responseReceivedAt: number, now = Date.now(), currentBlockHeight = prepared?.preparedBlockHeight) {
  if (!prepared || !Number.isFinite(responseReceivedAt) || !Number.isSafeInteger(prepared.walletSigningWindowMs) || prepared.walletSigningWindowMs! <= 0 || !Number.isSafeInteger(currentBlockHeight)) return { allowed: false, reason: 'invalid_preparation' as const, remainingWalletMs: 0, remainingBlockHeight: 0 };
  const remainingBlockHeight = prepared.lastValidBlockHeight - currentBlockHeight!;
  if (remainingBlockHeight < SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN) return { allowed: false, reason: 'blockhash_margin' as const, remainingWalletMs: 0, remainingBlockHeight };
  const serverExpiry = Date.parse(prepared.walletSigningExpiresAt ?? '');
  const clientExpiry = responseReceivedAt + prepared.walletSigningWindowMs!;
  const effectiveExpiry = Math.min(serverExpiry, clientExpiry);
  const remainingWalletMs = Number.isFinite(effectiveExpiry) ? effectiveExpiry - now : 0;
  if (remainingWalletMs < SWAP_MINIMUM_WALLET_OPEN_WINDOW_MS) return { allowed: false, reason: 'wallet_deadline' as const, remainingWalletMs, remainingBlockHeight };
  return { allowed: true, reason: 'safe' as const, remainingWalletMs, remainingBlockHeight };
}
