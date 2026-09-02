import type { WalletSigningError, WalletSigningFailureClassification } from '../../wallet/walletStandardSigning.js';
import { SEND_POST_SIGNATURE_BLOCK_MARGIN } from '../../../chains/solana/send/validity.js';

export const WALLET_BLOCK_POLL_MS = 1_000;
export type WalletApprovalOutcome =
  | { status: 'signed'; signedTransaction: Uint8Array; elapsedMs: number; blockHeight: number; remainingBlocks: number }
  | { status: 'failed'; classification: WalletSigningFailureClassification; elapsedMs: number; error: unknown }
  | { status: 'expired'; classification: 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN'; elapsedMs: number; blockHeight: number; remainingBlocks: number; userSignatureReturned: boolean };

export function walletFailureClassification(error: unknown): WalletSigningFailureClassification { if (error && typeof error === 'object' && 'classification' in error) return (error as WalletSigningError).classification; return 'UNKNOWN_WALLET_FAILURE'; }
export function walletReturnHasSubmissionMargin(lastValidBlockHeight: number, currentBlockHeight: number) { return lastValidBlockHeight - currentBlockHeight >= SEND_POST_SIGNATURE_BLOCK_MARGIN; }

export async function awaitWalletApproval({ sign, getBlockHeight, lastValidBlockHeight, now = Date.now, wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)), pollMs = WALLET_BLOCK_POLL_MS }: { sign: () => Promise<Uint8Array>; getBlockHeight: () => Promise<number>; lastValidBlockHeight: number; now?: () => number; wait?: (ms: number) => Promise<void>; pollMs?: number }): Promise<WalletApprovalOutcome> {
  const startedAt = now();
  const walletResult = Promise.resolve().then(sign).then((signedTransaction) => ({ kind: 'signed' as const, signedTransaction }), (error) => ({ kind: 'failed' as const, error }));
  let signedTransaction: Uint8Array | undefined; let retryingHeightRead = false;
  for (;;) {
    if (!signedTransaction) { const result = await Promise.race([walletResult, wait(pollMs).then(() => null)]); if (result?.kind === 'failed') return { status: 'failed', classification: walletFailureClassification(result.error), elapsedMs: now() - startedAt, error: result.error }; if (result?.kind === 'signed') signedTransaction = result.signedTransaction; }
    else if (retryingHeightRead) await wait(pollMs);
    let blockHeight: number;
    try { blockHeight = await getBlockHeight(); if (!Number.isSafeInteger(blockHeight)) throw new Error('Invalid block height'); retryingHeightRead = false; } catch { retryingHeightRead = true; continue; }
    const remainingBlocks = lastValidBlockHeight - blockHeight;
    if (signedTransaction) { if (!walletReturnHasSubmissionMargin(lastValidBlockHeight, blockHeight)) return { status: 'expired', classification: 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN', elapsedMs: now() - startedAt, blockHeight, remainingBlocks, userSignatureReturned: true }; return { status: 'signed', signedTransaction, elapsedMs: now() - startedAt, blockHeight, remainingBlocks }; }
    if (remainingBlocks < 0) return { status: 'expired', classification: 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN', elapsedMs: now() - startedAt, blockHeight, remainingBlocks, userSignatureReturned: false };
  }
}
