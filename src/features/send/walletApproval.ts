import type { WalletSigningFailureClassification } from '../../wallet/walletStandardSigning.js';
import { awaitWalletApproval, walletFailureClassification, walletReturnHasSubmissionMargin, WALLET_BLOCK_POLL_MS } from '../transactions/walletApproval.js';
import { SEND_POST_SIGNATURE_BLOCK_MARGIN } from '../../../chains/solana/send/validity.js';

export { SEND_POST_SIGNATURE_BLOCK_MARGIN };
export const SEND_WALLET_BLOCK_POLL_MS = WALLET_BLOCK_POLL_MS;

export type SendWalletApprovalOutcome =
  | { status: 'signed'; signedTransaction: Uint8Array; elapsedMs: number; blockHeight: number; remainingBlocks: number }
  | { status: 'failed'; classification: WalletSigningFailureClassification; elapsedMs: number; error: unknown; userSignatureReturned: boolean }
  | { status: 'expired'; classification: 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN'; elapsedMs: number; blockHeight: number; remainingBlocks: number; userSignatureReturned: boolean };

export { walletFailureClassification, walletReturnHasSubmissionMargin };

export async function awaitSendWalletApproval({ sign, getBlockHeight, lastValidBlockHeight, now = Date.now, wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)), pollMs = SEND_WALLET_BLOCK_POLL_MS }: {
  sign: () => Promise<Uint8Array>;
  getBlockHeight: () => Promise<number>;
  lastValidBlockHeight: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  pollMs?: number;
}): Promise<SendWalletApprovalOutcome> {
  return awaitWalletApproval({ sign, getBlockHeight, lastValidBlockHeight, now, wait, pollMs });
}
