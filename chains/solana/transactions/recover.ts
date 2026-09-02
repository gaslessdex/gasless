import { AddressLookupTableAccount, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { PreparedTransaction, RecoverAccount, SimulationResult, TransactionQuote, ValidatedTransaction } from '../../../shared/transactions/types.js';
import { GaslessError } from '../../../server/errors.js';
import { COMPUTE_BUDGET_PROGRAM_ID, JUPITER_SWAP_PROGRAM_ID, type JupiterBuild, jupiterInstruction } from '../../../server/jupiter/service.js';
import type { SolanaRpc } from '../../../server/solana/rpc.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../claim/accounts.js';
import { RECOVER_COMPUTE_UNIT_LIMIT, calculateCleanPriorityFeeLamports, cleanComputeBudget, validateSignedClean, versionedMessageHash } from './clean.js';
export { versionedMessageHash } from './clean.js';

export function calculateRecoverFees(minimumSwapOutput: bigint, rent: bigint, swapFeeBps: number, rentFeeBps: number) {
  for (const bps of [swapFeeBps, rentFeeBps]) if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new GaslessError('CONFIGURATION_ERROR', 'recover_economics', 'Recover Value fee policy is invalid.');
  return { swapFee: minimumSwapOutput * BigInt(swapFeeBps) / 10_000n, rentFee: rent * BigInt(rentFeeBps) / 10_000n };
}

export function calculateRecoverMinimumPayout(minimumSwapOutput: bigint, rent: bigint, swapFee: bigint, rentFee: bigint, network: bigint, minimum: bigint) {
  const payout = minimumSwapOutput + rent - swapFee - rentFee - network;
  if (payout < minimum) throw new GaslessError('TOKEN_UNSUPPORTED', 'recover_economics', 'This route cannot safely meet the minimum Recover Value payout.');
  return payout;
}

function closeAccountInstruction(account: string, wallet: PublicKey) {
  return new TransactionInstruction({ programId: new PublicKey(LEGACY_TOKEN_PROGRAM_ID), keys: [{ pubkey: new PublicKey(account), isSigner: false, isWritable: true }, { pubkey: wallet, isSigner: false, isWritable: true }, { pubkey: wallet, isSigner: true, isWritable: false }], data: Buffer.from([9]) });
}

function lookupTables(build: JupiterBuild) {
  return Object.entries(build.addressesByLookupTableAddress ?? {}).map(([key, addresses]) => new AddressLookupTableAccount({ key: new PublicKey(key), state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: addresses.map((address) => new PublicKey(address)) } }));
}

function buildInstructions(input: { build: JupiterBuild; account: RecoverAccount; wallet: PublicKey; feeDestination: PublicKey; settlementLamports: bigint; computeUnitLimit: number; includeSetup: boolean }) {
  return [...cleanComputeBudget(input.computeUnitLimit), ...(input.includeSetup ? input.build.setupInstructions.map(jupiterInstruction) : []), jupiterInstruction(input.build.swapInstruction), closeAccountInstruction(input.account.address, input.wallet), ...(input.build.cleanupInstruction ? [jupiterInstruction(input.build.cleanupInstruction)] : []), SystemProgram.transfer({ fromPubkey: input.wallet, toPubkey: input.feeDestination, lamports: input.settlementLamports })];
}

export function buildRecoverTransaction(input: { build: JupiterBuild; account: RecoverAccount; walletAddress: string; feePayer: string; feeDestination: string; settlementLamports: bigint; computeUnitLimit?: number; includeSetup?: boolean }) {
  const wallet = new PublicKey(input.walletAddress);
  const recentBlockhash = new PublicKey(Uint8Array.from(input.build.blockhashWithMetadata.blockhash)).toBase58();
  const instructions = buildInstructions({ ...input, wallet, feeDestination: new PublicKey(input.feeDestination), computeUnitLimit: input.computeUnitLimit ?? RECOVER_COMPUTE_UNIT_LIMIT, includeSetup: input.includeSetup ?? true });
  const message = new TransactionMessage({ payerKey: new PublicKey(input.feePayer), recentBlockhash, instructions }).compileToV0Message(lookupTables(input.build));
  return new VersionedTransaction(message);
}

function serialize(transaction: VersionedTransaction) { return Buffer.from(transaction.serialize()).toString('base64'); }

export async function prepareRecoverTransaction(input: { quote: TransactionQuote; account: RecoverAccount; build: JupiterBuild; swapFeeLamports: bigint; rentFeeLamports: bigint; temporaryAccountRentLamports: bigint; includeSetup: boolean; minimumUserPayoutLamports: bigint; feePayer: string; feeDestination: string; rpc: SolanaRpc }) {
  const walletAddress = input.quote.intent.walletAddress;
  const accountKeys = input.build.swapInstruction.accounts.map((account) => account.pubkey);
  if (!accountKeys.includes(input.account.address) || !accountKeys.includes(walletAddress)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The Jupiter route is not bound to the selected token account and wallet.');
  const serviceFeesLamports = input.swapFeeLamports + input.rentFeeLamports;
  const estimate = buildRecoverTransaction({ ...input, walletAddress, settlementLamports: serviceFeesLamports + input.temporaryAccountRentLamports });
  const firstSimulation = await input.rpc.simulateTransaction(serialize(estimate), false);
  if (firstSimulation.err !== null) throw new GaslessError('SIMULATION_FAILED', 'pre_signature_simulation', "This Recover Value route couldn't be safely completed. Nothing was submitted.");
  const computeUnitLimit = RECOVER_COMPUTE_UNIT_LIMIT;
  const priced = buildRecoverTransaction({ ...input, walletAddress, settlementLamports: serviceFeesLamports + input.temporaryAccountRentLamports, computeUnitLimit });
  const fee = await input.rpc.getFeeForMessage(Buffer.from(priced.message.serialize()).toString('base64'));
  if (fee === null) throw new GaslessError('RPC_ERROR', 'recover_fee', 'The Solana network fee could not be calculated.', true);
  if (BigInt(fee) < calculateCleanPriorityFeeLamports(computeUnitLimit)) throw new GaslessError('RPC_ERROR', 'recover_fee', 'The network returned an incomplete sponsored cost.', true);
  const sponsoredCostLamports = BigInt(fee);
  const minimumUserPayout = calculateRecoverMinimumPayout(BigInt(input.build.otherAmountThreshold), BigInt(input.account.recoverableLamports), input.swapFeeLamports, input.rentFeeLamports, sponsoredCostLamports, input.minimumUserPayoutLamports);
  const transaction = buildRecoverTransaction({ ...input, walletAddress, settlementLamports: serviceFeesLamports + sponsoredCostLamports + input.temporaryAccountRentLamports, computeUnitLimit });
  const exactFee = await input.rpc.getFeeForMessage(Buffer.from(transaction.message.serialize()).toString('base64'));
  if (exactFee !== fee) throw new GaslessError('RPC_ERROR', 'recover_fee', 'The Solana network fee changed while preparing Recover Value.', true);
  const simulated = await input.rpc.simulateTransaction(serialize(transaction), false);
  const simulation: SimulationResult = { success: simulated.err === null, errorCode: simulated.err ? 'SIMULATION_FAILED' : undefined, logs: simulated.logs ?? undefined, unitsConsumed: simulated.unitsConsumed, provider: simulated.provider, simulatedAt: new Date().toISOString() };
  if (!simulation.success) throw new GaslessError('SIMULATION_FAILED', 'pre_signature_simulation', "This Recover Value route couldn't be safely completed. Nothing was submitted.");
  const recentBlockhash = new PublicKey(Uint8Array.from(input.build.blockhashWithMetadata.blockhash)).toBase58();
  const prepared: PreparedTransaction = { transactionId: crypto.randomUUID(), quoteId: input.quote.quoteId, intentId: input.quote.intent.intentId, walletAddress, network: input.quote.intent.network, serializedTransaction: serialize(transaction), preparedMessageHash: versionedMessageHash(transaction), expectedFeePayer: input.feePayer, expectedSigners: [input.feePayer, walletAddress], allowedProgramIds: [COMPUTE_BUDGET_PROGRAM_ID, LEGACY_TOKEN_PROGRAM_ID, JUPITER_SWAP_PROGRAM_ID, SystemProgram.programId.toBase58(), 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'], recentBlockhash, lastValidBlockHeight: input.build.blockhashWithMetadata.lastValidBlockHeight, simulation };
  return { prepared, networkFeeLamports: sponsoredCostLamports, sponsoredCostLamports: sponsoredCostLamports + input.temporaryAccountRentLamports, minimumUserPayout };
}

export async function validateSignedRecover(serializedTransaction: string, prepared: PreparedTransaction, rpc: SolanaRpc): Promise<ValidatedTransaction> {
  return validateSignedClean({ serialized: serializedTransaction, prepared, rpc, action: 'Recover Value', allowLookupTables: true });
}
