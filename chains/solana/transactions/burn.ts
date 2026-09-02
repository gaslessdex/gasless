import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { BurnAccount, PreparedTransaction, SimulationResult, TransactionQuote, ValidatedTransaction } from '../../../shared/transactions/types.js';
import { GaslessError } from '../../../server/errors.js';
import type { SolanaRpc } from '../../../server/solana/rpc.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../claim/accounts.js';
import { BURN_COMPUTE_UNIT_LIMIT, calculateCleanPriorityFeeLamports, cleanComputeBudget, validateSignedClean, versionedMessageHash } from './clean.js';

export function calculateBurnFee(reclaimedRentLamports: bigint, feeBps: number) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new GaslessError('CONFIGURATION_ERROR', 'burn_economics', 'Burn fee policy is invalid.');
  return reclaimedRentLamports * BigInt(feeBps) / 10_000n;
}

export function calculateBurnNet(rent: bigint, serviceFee: bigint, sponsoredCost: bigint, minimum: bigint) {
  const net = rent - serviceFee - sponsoredCost;
  if (net < minimum) throw new GaslessError('TOKEN_UNSUPPORTED', 'burn_economics', 'This token account cannot safely cover the gasless Burn costs.');
  return net;
}

function burnInstruction(account: BurnAccount, wallet: PublicKey) {
  const data = Buffer.alloc(10); data[0] = 15; data.writeBigUInt64LE(BigInt(account.tokenAmountRaw), 1); data[9] = account.decimals;
  return new TransactionInstruction({ programId: new PublicKey(LEGACY_TOKEN_PROGRAM_ID), keys: [
    { pubkey: new PublicKey(account.address), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(account.mint), isSigner: false, isWritable: true },
    { pubkey: wallet, isSigner: true, isWritable: false },
  ], data });
}

export function buildBurnTransaction(input: { account: BurnAccount; walletAddress: string; feePayer: string; feeDestination: string; blockhash: string; settlementLamports: bigint }) {
  const wallet = new PublicKey(input.walletAddress);
  const instructions = [...cleanComputeBudget(BURN_COMPUTE_UNIT_LIMIT), burnInstruction(input.account, wallet), new TransactionInstruction({ programId: new PublicKey(LEGACY_TOKEN_PROGRAM_ID), keys: [
    { pubkey: new PublicKey(input.account.address), isSigner: false, isWritable: true }, { pubkey: wallet, isSigner: false, isWritable: true }, { pubkey: wallet, isSigner: true, isWritable: false },
  ], data: Buffer.from([9]) }), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: new PublicKey(input.feeDestination), lamports: Number(input.settlementLamports) })];
  return new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(input.feePayer), recentBlockhash: input.blockhash, instructions }).compileToV0Message());
}

export async function prepareBurnTransaction(input: { quote: TransactionQuote; account: BurnAccount; gaslessFeeLamports: bigint; minimumUserPayoutLamports: bigint; feePayer: string; feeDestination: string; rpc: SolanaRpc }) {
  const latest = await input.rpc.getLatestBlockhash();
  const estimate = buildBurnTransaction({ ...input, walletAddress: input.quote.intent.walletAddress, blockhash: latest.blockhash, settlementLamports: input.gaslessFeeLamports });
  const fee = await input.rpc.getFeeForMessage(Buffer.from(estimate.message.serialize()).toString('base64'));
  if (fee === null) throw new GaslessError('RPC_ERROR', 'burn_fee', 'The Solana network fee could not be calculated.', true);
  if (BigInt(fee) < calculateCleanPriorityFeeLamports(BURN_COMPUTE_UNIT_LIMIT)) throw new GaslessError('RPC_ERROR', 'burn_fee', 'The network returned an incomplete sponsored cost.', true);
  const sponsoredCostLamports = BigInt(fee);
  const netUserLamports = calculateBurnNet(BigInt(input.account.recoverableLamports), input.gaslessFeeLamports, sponsoredCostLamports, input.minimumUserPayoutLamports);
  const transaction = buildBurnTransaction({ ...input, walletAddress: input.quote.intent.walletAddress, blockhash: latest.blockhash, settlementLamports: input.gaslessFeeLamports + sponsoredCostLamports });
  const exactFee = await input.rpc.getFeeForMessage(Buffer.from(transaction.message.serialize()).toString('base64'));
  if (exactFee !== fee) throw new GaslessError('RPC_ERROR', 'burn_fee', 'The Solana network fee changed while preparing Burn.', true);
  const serialized = Buffer.from(transaction.serialize()).toString('base64');
  const simulated = await input.rpc.simulateTransaction(serialized, false);
  const simulation: SimulationResult = { success: simulated.err === null, errorCode: simulated.err ? 'SIMULATION_FAILED' : undefined, logs: simulated.logs ?? undefined, unitsConsumed: simulated.unitsConsumed, provider: simulated.provider, simulatedAt: new Date().toISOString() };
  if (!simulation.success) throw new GaslessError('SIMULATION_FAILED', 'pre_signature_simulation', "This Burn couldn't be safely completed. Nothing was submitted.");
  const prepared: PreparedTransaction = { transactionId: crypto.randomUUID(), quoteId: input.quote.quoteId, intentId: input.quote.intent.intentId, walletAddress: input.quote.intent.walletAddress, network: input.quote.intent.network, serializedTransaction: serialized, preparedMessageHash: versionedMessageHash(transaction), expectedFeePayer: input.feePayer, expectedSigners: [input.feePayer, input.quote.intent.walletAddress], allowedProgramIds: [ComputeBudgetProgram.programId.toBase58(), LEGACY_TOKEN_PROGRAM_ID, SystemProgram.programId.toBase58()], recentBlockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, simulation };
  return { prepared, sponsoredCostLamports, netUserLamports };
}

export async function validateSignedBurn(serialized: string, prepared: PreparedTransaction, rpc: SolanaRpc): Promise<ValidatedTransaction> {
  return validateSignedClean({ serialized, prepared, rpc, action: 'Burn' });
}
