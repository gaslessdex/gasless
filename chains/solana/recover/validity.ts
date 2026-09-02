import { SEND_POST_SIGNATURE_BLOCK_MARGIN } from '../send/validity.js';

// Production observations use a conservative 400 ms/block (2.5 blocks/second).
// 30 seconds for Phantom + the proven 30-block post-sign floor + 5 blocks of
// scheduling/RPC variance = 110 blocks at the wallet-invocation boundary.
export const RECOVER_MAX_APPROVAL_SECONDS = 30;
export const RECOVER_CONSERVATIVE_BLOCKS_PER_SECOND = 2.5;
export const RECOVER_TIMING_VARIANCE_BLOCKS = 5;
export const RECOVER_PRE_WALLET_MINIMUM_BLOCK_MARGIN = Math.ceil(RECOVER_MAX_APPROVAL_SECONDS * RECOVER_CONSERVATIVE_BLOCKS_PER_SECOND) + SEND_POST_SIGNATURE_BLOCK_MARGIN + RECOVER_TIMING_VARIANCE_BLOCKS;

export function evaluateRecoverApprovalDelay(seconds: number, openingBlocks = RECOVER_PRE_WALLET_MINIMUM_BLOCK_MARGIN) {
  if (!Number.isFinite(seconds) || seconds < 0) return { safe: false, remainingBlocks: 0 };
  const remainingBlocks = openingBlocks - Math.ceil(seconds * RECOVER_CONSERVATIVE_BLOCKS_PER_SECOND);
  return { safe: remainingBlocks >= SEND_POST_SIGNATURE_BLOCK_MARGIN, remainingBlocks };
}
