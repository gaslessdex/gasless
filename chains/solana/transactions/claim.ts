import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { ClaimAccount, PreparedTransaction, SimulationResult, TransactionQuote, ValidatedTransaction } from '../../../shared/transactions/types.js';
import { GaslessError } from '../../../server/errors.js';
import type { SolanaRpc } from '../../../server/solana/rpc.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../claim/accounts.js';
import { CLAIM_COMPUTE_UNIT_LIMIT, calculateCleanPriorityFeeLamports, cleanComputeBudget, validateSignedClean, versionedMessageHash } from './clean.js';

export const MAX_SOLANA_TRANSACTION_BYTES = 1_232;
export const CLAIM_MAX_ACCOUNTS_PER_TRANSACTION = 10;

export function calculateClaimFee(grossLamports: bigint, feeBps: number) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new GaslessError('CONFIGURATION_ERROR', 'claim_economics', 'Claim fee policy is invalid.');
  return grossLamports * BigInt(feeBps) / 10_000n;
}

export function calculateClaimNet(grossLamports: bigint, serviceFeeLamports: bigint, sponsoredCostLamports: bigint, minimumUserPayoutLamports: bigint) {
  const net = grossLamports - serviceFeeLamports - sponsoredCostLamports;
  if (net < minimumUserPayoutLamports) throw new GaslessError('TOKEN_UNSUPPORTED', 'claim_economics', 'The available account SOL is too small for a safe gasless claim.');
  return net;
}

function closeAccountInstruction(account: ClaimAccount, wallet: PublicKey) {
  return new TransactionInstruction({
    programId: new PublicKey(LEGACY_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(account.address), isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

export function buildClaimTransaction(input: { accounts: ClaimAccount[]; walletAddress: string; feePayer: string; feeDestination: string; blockhash: string; settlementLamports: bigint }) {
  const wallet = new PublicKey(input.walletAddress);
  const feePayer = new PublicKey(input.feePayer);
  const feeDestination = new PublicKey(input.feeDestination);
  if (feePayer.equals(feeDestination)) throw new GaslessError('CONFIGURATION_ERROR', 'claim_prepare', 'The Claim fee destination must be separate from the GASLESS relayer.');
  if (!input.accounts.length) throw new GaslessError('INVALID_REQUEST', 'claim_prepare', 'No eligible accounts were provided.');
  if (input.accounts.length > CLAIM_MAX_ACCOUNTS_PER_TRANSACTION) throw new GaslessError('INVALID_REQUEST', 'claim_batching', 'This Claim exceeds the maximum account count.');
  if (new Set(input.accounts.map((account) => account.address)).size !== input.accounts.length) throw new GaslessError('INVALID_REQUEST', 'claim_batching', 'A Claim account was included more than once.');
  if (input.settlementLamports < 0n || input.settlementLamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new GaslessError('CONFIGURATION_ERROR', 'claim_economics', 'Claim settlement amount is outside the supported range.');
  const instructions = [...cleanComputeBudget(CLAIM_COMPUTE_UNIT_LIMIT), ...input.accounts.map((account) => closeAccountInstruction(account, wallet)), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: feeDestination, lamports: Number(input.settlementLamports) })];
  return new VersionedTransaction(new TransactionMessage({ payerKey: feePayer, recentBlockhash: input.blockhash, instructions }).compileToV0Message());
}

export async function prepareClaimTransaction(input: {
  quote: TransactionQuote;
  batchIndex: number;
  accounts: ClaimAccount[];
  gaslessFeeLamports: bigint;
  minimumUserPayoutLamports: bigint;
  feePayer: string;
  feeDestination: string;
  rpc: SolanaRpc;
}): Promise<{ prepared: PreparedTransaction; sponsoredCostLamports: bigint; netUserLamports: bigint }> {
  if (input.quote.intent.actionType !== 'CLEAN_CLAIM') throw new GaslessError('INVALID_REQUEST', 'claim_prepare', 'This quote is not a Claim SOL quote.');
  const latest = await input.rpc.getLatestBlockhash();
  const estimate = buildClaimTransaction({ ...input, walletAddress: input.quote.intent.walletAddress, blockhash: latest.blockhash, settlementLamports: input.gaslessFeeLamports });
  const estimatedFee = await input.rpc.getFeeForMessage(Buffer.from(estimate.message.serialize()).toString('base64'));
  if (estimatedFee === null) throw new GaslessError('RPC_ERROR', 'claim_fee', 'The Solana network fee could not be calculated.', true);
  if (BigInt(estimatedFee) < calculateCleanPriorityFeeLamports(CLAIM_COMPUTE_UNIT_LIMIT)) throw new GaslessError('RPC_ERROR', 'claim_fee', 'The network returned an incomplete sponsored cost.', true);
  const sponsoredCostLamports = BigInt(estimatedFee);
  const gross = input.accounts.reduce((sum, account) => sum + BigInt(account.recoverableLamports), 0n);
  const netUserLamports = calculateClaimNet(gross, input.gaslessFeeLamports, sponsoredCostLamports, input.minimumUserPayoutLamports);
  const transaction = buildClaimTransaction({ ...input, walletAddress: input.quote.intent.walletAddress, blockhash: latest.blockhash, settlementLamports: input.gaslessFeeLamports + sponsoredCostLamports });
  const exactFee = await input.rpc.getFeeForMessage(Buffer.from(transaction.message.serialize()).toString('base64'));
  if (exactFee === null || BigInt(exactFee) !== sponsoredCostLamports) throw new GaslessError('RPC_ERROR', 'claim_fee', 'The Solana network fee changed while preparing this claim.', true);
  const serializedBytes = transaction.serialize();
  if (serializedBytes.length > MAX_SOLANA_TRANSACTION_BYTES) throw new GaslessError('INVALID_REQUEST', 'claim_batching', 'This claim batch exceeds Solana transaction limits.');
  const serialized = Buffer.from(serializedBytes).toString('base64');
  const simulated = await input.rpc.simulateTransaction(serialized, false);
  const simulation: SimulationResult = { success: simulated.err === null, errorCode: simulated.err ? 'SIMULATION_FAILED' : undefined, logs: simulated.logs ?? undefined, unitsConsumed: simulated.unitsConsumed, provider: simulated.provider, simulatedAt: new Date().toISOString() };
  if (!simulation.success) throw new GaslessError('SIMULATION_FAILED', 'pre_signature_simulation', "This claim couldn't be safely completed. Nothing was submitted.");
  const prepared: PreparedTransaction = {
    transactionId: crypto.randomUUID(), quoteId: input.quote.quoteId, intentId: input.quote.intent.intentId,
    walletAddress: input.quote.intent.walletAddress, network: input.quote.intent.network, serializedTransaction: serialized,
    preparedMessageHash: versionedMessageHash(transaction), expectedFeePayer: input.feePayer,
    expectedSigners: [input.feePayer, input.quote.intent.walletAddress],
    allowedProgramIds: [ComputeBudgetProgram.programId.toBase58(), LEGACY_TOKEN_PROGRAM_ID, SystemProgram.programId.toBase58()],
    recentBlockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, simulation,
  };
  return { prepared, sponsoredCostLamports, netUserLamports };
}

export async function validateSignedClaim(serialized: string, prepared: PreparedTransaction, rpc: SolanaRpc): Promise<ValidatedTransaction> {
  return validateSignedClean({ serialized, prepared, rpc, action: 'Claim' });
}
