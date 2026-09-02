import { createHash, createPublicKey, verify } from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { PreparedTransaction, ValidatedTransaction } from '../../../shared/transactions/types.js';
import { GaslessError } from '../../../server/errors.js';
import type { SolanaRpc } from '../../../server/solana/rpc.js';
import { PHANTOM_LIGHTHOUSE_PROGRAM_ID, validatePhantomCompatibleTransaction } from './phantom.js';

export const CLEAN_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 375_000n;
export const CLAIM_COMPUTE_UNIT_LIMIT = 100_000;
export const BURN_COMPUTE_UNIT_LIMIT = 100_000;
// The fresh Mainnet USDT -> wSOL route consumed 63,375 units. 100k leaves a
// 57% margin without exposing the payer to Jupiter's former 1.4m ceiling.
export const RECOVER_COMPUTE_UNIT_LIMIT = 100_000;

export function versionedMessageHash(transaction: VersionedTransaction) { return createHash('sha256').update(transaction.message.serialize()).digest('hex'); }

export function versionedSignerSignatureIsValid(transaction: VersionedTransaction, signerIndex: number, expectedSigner: string) {
  const signature = transaction.signatures[signerIndex];
  if (!signature || signature.every((byte) => byte === 0)) return false;
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(expectedSigner).toBuffer()]);
  return verify(null, transaction.message.serialize(), createPublicKey({ key: der, format: 'der', type: 'spki' }), signature);
}

export function cleanComputeBudget(units: number) {
  if (!Number.isSafeInteger(units) || units <= 0 || units > RECOVER_COMPUTE_UNIT_LIMIT) throw new GaslessError('CONFIGURATION_ERROR', 'clean_compute_budget', 'CLEAN compute-budget policy is invalid.');
  return [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CLEAN_COMPUTE_UNIT_PRICE_MICROLAMPORTS }),
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ];
}

export function calculateCleanPriorityFeeLamports(units: number) {
  cleanComputeBudget(units);
  return (BigInt(units) * CLEAN_COMPUTE_UNIT_PRICE_MICROLAMPORTS + 999_999n) / 1_000_000n;
}

export async function validateSignedClean(input: { serialized: string; prepared: PreparedTransaction; rpc: SolanaRpc; action: 'Claim' | 'Burn' | 'Recover Value'; allowLookupTables?: boolean }) {
  let transaction: VersionedTransaction; let preparedTransaction: VersionedTransaction;
  try { transaction = VersionedTransaction.deserialize(Buffer.from(input.serialized, 'base64')); preparedTransaction = VersionedTransaction.deserialize(Buffer.from(input.prepared.serializedTransaction, 'base64')); }
  catch { throw new GaslessError('INVALID_REQUEST', 'signed_message_validation', `The signed ${input.action} transaction could not be read.`); }
  const keys = transaction.message.staticAccountKeys;
  const signerCount = transaction.message.header.numRequiredSignatures;
  const signers = keys.slice(0, signerCount).map(String);
  const programs = transaction.message.compiledInstructions.map((instruction) => keys[instruction.programIdIndex]?.toBase58());
  const compatible = validatePhantomCompatibleTransaction(preparedTransaction, transaction);
  if (!compatible.accepted || transaction.version !== 0 || (!input.allowLookupTables && transaction.message.addressTableLookups.length !== 0) || transaction.message.recentBlockhash !== input.prepared.recentBlockhash || signerCount !== 2 || signers[0] !== input.prepared.expectedFeePayer || signers[1] !== input.prepared.walletAddress || programs.some((program) => !program || (!input.prepared.allowedProgramIds.includes(program) && program !== PHANTOM_LIGHTHOUSE_PROGRAM_ID))) throw new GaslessError('MESSAGE_MISMATCH', 'signed_message_validation', `${input.action} changed after the preview. Review it again.`);
  const payerSignatureEmpty = transaction.signatures[0]?.every((byte) => byte === 0) === true;
  if (!payerSignatureEmpty || !versionedSignerSignatureIsValid(transaction, 1, input.prepared.walletAddress)) throw new GaslessError('USER_SIGNATURE_INVALID', 'signed_message_validation', 'The connected wallet signature is invalid.');
  if (await input.rpc.getBlockHeight() > input.prepared.lastValidBlockHeight) throw new GaslessError('QUOTE_EXPIRED', 'signed_message_validation', `This ${input.action} preparation expired. Review it again.`);
  const validated: ValidatedTransaction = { transactionId: input.prepared.transactionId, quoteId: input.prepared.quoteId, serializedTransaction: input.serialized, messageHash: versionedMessageHash(transaction), walletAddress: input.prepared.walletAddress, validatedAt: new Date().toISOString() };
  return validated;
}
