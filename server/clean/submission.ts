import type { PreparedTransaction } from '../../shared/transactions/types.js';
import type { SolanaRpc } from '../solana/rpc.js';
import type { DurableStore } from '../storage/durable.js';

export const CLEAN_BROADCAST_MAX_ROUNDS = 3;
export const CLEAN_BROADCAST_CADENCE_MS = 1_000;
export const CLEAN_BROADCAST_SAFETY_FLOOR_BLOCKS = 20;

export type CleanConfirmation = {
  signature: string;
  outcome: 'confirmed_success' | 'confirmed_chain_error' | 'expired' | 'timeout_unknown';
  provider?: string;
  slot?: number;
  confirmedAt?: string;
  blockHeight?: number;
  error?: unknown;
};

export async function observeCleanSignature(rpc: SolanaRpc, signature: string, lastValidBlockHeight?: number): Promise<CleanConfirmation> {
  const statuses = await rpc.getSignatureStatusesAcrossProviders(signature);
  const success = statuses.find((observation) => observation.value?.confirmationStatus === 'confirmed' || observation.value?.confirmationStatus === 'finalized');
  if (success?.value) return { signature, outcome: 'confirmed_success', provider: success.provider, slot: success.value.slot, confirmedAt: new Date().toISOString() };
  const chainError = statuses.find((observation) => observation.value?.err);
  if (chainError?.value) return { signature, outcome: 'confirmed_chain_error', provider: chainError.provider, slot: chainError.value.slot, error: chainError.value.err, confirmedAt: new Date().toISOString() };
  const heights = await rpc.getBlockHeightsAcrossProviders();
  const readableHeights = heights.flatMap((observation) => observation.value === undefined ? [] : [observation.value]);
  const blockHeight = readableHeights.length ? Math.max(...readableHeights) : undefined;
  const allStatusesAbsent = statuses.length > 0 && statuses.every((observation) => observation.errorCategory === undefined && observation.value === null);
  const allProvidersExpired = lastValidBlockHeight !== undefined && heights.length > 0 && heights.every((observation) => observation.errorCategory === undefined && observation.value !== undefined && observation.value > lastValidBlockHeight);
  if (allStatusesAbsent && allProvidersExpired) return { signature, outcome: 'expired', blockHeight };
  return { signature, outcome: 'timeout_unknown', blockHeight };
}

export async function confirmCleanSignature(rpc: SolanaRpc, signature: string, lastValidBlockHeight: number) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const confirmation = await observeCleanSignature(rpc, signature, lastValidBlockHeight);
    if (confirmation.outcome !== 'timeout_unknown') return confirmation;
    await new Promise((resolve) => setTimeout(resolve, CLEAN_BROADCAST_CADENCE_MS));
  }
  return { signature, outcome: 'timeout_unknown' as const };
}

export async function recordCleanConfirmationObservation(input: { durable: DurableStore; eventPrefix: 'claim' | 'burn' | 'recover'; transactionId: string; signedMessageHash?: string; confirmation: CleanConfirmation }) {
  const observedAt = input.confirmation.confirmedAt ?? new Date().toISOString();
  await input.durable.appendEvent(input.transactionId, `${input.eventPrefix}_confirmation_observed`, 'confirming', { transactionId: input.transactionId, canonicalSignature: input.confirmation.signature, provider: input.confirmation.provider, outcome: input.confirmation.outcome, slot: input.confirmation.slot, blockHeight: input.confirmation.blockHeight, observedAt, signedMessageHash: input.signedMessageHash }, `${input.transactionId}:confirmation:${input.confirmation.outcome}`);
}

export async function broadcastAndConfirmClean(input: { rpc: SolanaRpc; durable: DurableStore; eventPrefix: 'claim' | 'burn' | 'recover'; prepared: PreparedTransaction; fullySigned: string; canonicalSignature: string; signedMessageHash?: string }) {
  const signedMessageHash = input.signedMessageHash ?? input.prepared.preparedMessageHash;
  for (let ordinal = 1; ordinal <= CLEAN_BROADCAST_MAX_ROUNDS; ordinal += 1) {
    const heights = await input.rpc.getBlockHeightsAcrossProviders();
    const readableHeights = heights.flatMap((observation) => observation.value === undefined ? [] : [observation.value]);
    const blockHeight = readableHeights.length ? Math.max(...readableHeights) : undefined;
    const remainingBlocks = blockHeight === undefined ? undefined : input.prepared.lastValidBlockHeight - blockHeight;
    if (remainingBlocks === undefined || remainingBlocks < CLEAN_BROADCAST_SAFETY_FLOOR_BLOCKS) return observeCleanSignature(input.rpc, input.canonicalSignature, input.prepared.lastValidBlockHeight);
    const attemptedAt = new Date().toISOString();
    const observations = await input.rpc.broadcastRawTransactionAcrossProviders(input.fullySigned);
    for (const observation of observations) {
      const responseCategory = observation.returnedSignature && observation.returnedSignature !== input.canonicalSignature ? 'signature_mismatch' : observation.category;
      await input.durable.appendEvent(input.prepared.transactionId, `${input.eventPrefix}_broadcast_observed`, 'submitted', { transactionId: input.prepared.transactionId, canonicalSignature: input.canonicalSignature, provider: observation.provider, attemptOrdinal: ordinal, attemptedAt, blockHeight, remainingBlocks, responseCategory, rpcReturnedSignature: observation.returnedSignature, errorCode: observation.errorCode, signedMessageHash }, `${input.prepared.transactionId}:broadcast:${ordinal}:${observation.provider}`);
    }
    const confirmation = await observeCleanSignature(input.rpc, input.canonicalSignature, input.prepared.lastValidBlockHeight);
    if (confirmation.outcome !== 'timeout_unknown') {
      await recordCleanConfirmationObservation({ durable: input.durable, eventPrefix: input.eventPrefix, transactionId: input.prepared.transactionId, signedMessageHash, confirmation });
      return confirmation;
    }
    if (ordinal < CLEAN_BROADCAST_MAX_ROUNDS) await new Promise((resolve) => setTimeout(resolve, CLEAN_BROADCAST_CADENCE_MS));
  }
  return { signature: input.canonicalSignature, outcome: 'timeout_unknown' as const };
}
