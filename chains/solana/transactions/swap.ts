import { createPublicKey, verify } from 'node:crypto';
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { PreparedTransaction, SimulationResult, SwapQuoteDetails, TransactionQuote, ValidatedTransaction } from '../../../shared/transactions/types.js';
import { GaslessError } from '../../../server/errors.js';
import { APPROVED_DEX_FAMILIES, COMPUTE_BUDGET_PROGRAM_ID, JUPITER_SWAP_PROGRAM_ID, METEORA_DLMM_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, RAYDIUM_CLMM_PROGRAM_ID, SYSTEM_PROGRAM_ID, approvedDexProgram, type JupiterBuild, jupiterInstruction, routeDexFamily } from '../../../server/jupiter/service.js';
import type { RpcInnerInstructionGroup, SolanaRpc } from '../../../server/solana/rpc.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '../send/accounts.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../claim/accounts.js';
import { signingDeadlineIsActive } from '../swap/validity.js';
import { versionedMessageHash } from './clean.js';
import { validatePhantomCompatibleTransaction } from './phantom.js';

const MAX_COMPUTE_UNITS = 1_400_000;
const MAX_SOLANA_TRANSACTION_BYTES = 1_232;

export function parseTokenAmount(value: string, decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new GaslessError('INVALID_REQUEST', 'swap_amount', 'Enter a valid amount greater than zero.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new GaslessError('INVALID_REQUEST', 'swap_amount', `This token supports up to ${decimals} decimal places.`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (raw <= 0n) throw new GaslessError('INVALID_REQUEST', 'swap_amount', 'Enter an amount greater than zero.');
  return raw;
}

export function calculateSwapServiceFee(totalInputRaw: bigint, feeBps = 30) {
  if (totalInputRaw < 0n || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new GaslessError('CONFIGURATION_ERROR', 'swap_economics', 'Swap fee policy is invalid.');
  return totalInputRaw * BigInt(feeBps) / 10_000n;
}

export function calculateRoutedInput(totalInputRaw: bigint, serviceFeeRaw: bigint, reimbursementRaw: bigint) {
  const routed = totalInputRaw - serviceFeeRaw - reimbursementRaw;
  if (routed <= 0n) throw new GaslessError('TOKEN_UNSUPPORTED', 'swap_economics', 'This amount is too small to cover the swap and sponsored network cost.');
  return routed;
}

function transferChecked(source: string, mint: string, destination: string, owner: string, amount: bigint, decimals: number) {
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = decimals;
  return new TransactionInstruction({ programId: new PublicKey(LEGACY_TOKEN_PROGRAM_ID), keys: [
    { pubkey: new PublicKey(source), isSigner: false, isWritable: true }, { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(destination), isSigner: false, isWritable: true }, { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
  ], data });
}

function lookupTables(build: JupiterBuild) { return Object.entries(build.addressesByLookupTableAddress ?? {}).map(([key, addresses]) => new AddressLookupTableAccount({ key: new PublicKey(key), state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: addresses.map((address) => new PublicKey(address)) } })); }

export const PUMP_FEE_PROGRAM_ID = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const SWAP_ALLOWED_PROGRAM_IDS = [SYSTEM_PROGRAM_ID, LEGACY_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, JUPITER_SWAP_PROGRAM_ID, RAYDIUM_CLMM_PROGRAM_ID, METEORA_DLMM_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, MEMO_PROGRAM_ID] as const;

function resolvedKeys(transaction: VersionedTransaction, build: JupiterBuild) {
  const writable: string[] = []; const readonly: string[] = [];
  for (const lookup of transaction.message.addressTableLookups) {
    const addresses = build.addressesByLookupTableAddress[lookup.accountKey.toBase58()];
    if (!addresses) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The swap lookup table could not be resolved.');
    for (const index of lookup.writableIndexes) { if (!addresses[index]) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The swap lookup table is invalid.'); writable.push(addresses[index]); }
    for (const index of lookup.readonlyIndexes) { if (!addresses[index]) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The swap lookup table is invalid.'); readonly.push(addresses[index]); }
  }
  return [...transaction.message.staticAccountKeys.map(String), ...writable, ...readonly];
}

export function validateSwapProgramShape(transaction: VersionedTransaction, build: JupiterBuild, innerGroups: RpcInnerInstructionGroup[] | null | undefined, outputAtaExists: boolean, payer: string, wallet: string) {
  const keys = resolvedKeys(transaction, build); const allowed = new Set<string>(SWAP_ALLOWED_PROGRAM_IDS); const outerPrograms = transaction.message.compiledInstructions.map((instruction) => keys[instruction.programIdIndex]);
  const family = routeDexFamily(build); const expectedDexProgram = approvedDexProgram(family); const dexPrograms = new Set<string>(APPROVED_DEX_FAMILIES.map(approvedDexProgram));
  const allowedOuter = new Set([COMPUTE_BUDGET_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, JUPITER_SWAP_PROGRAM_ID, LEGACY_TOKEN_PROGRAM_ID]);
  if (outerPrograms.some((program) => !program || !allowedOuter.has(program)) || outerPrograms.filter((program) => program === JUPITER_SWAP_PROGRAM_ID).length !== 1 || outerPrograms.filter((program) => program === LEGACY_TOKEN_PROGRAM_ID).length !== 2 || outerPrograms.filter((program) => program === ASSOCIATED_TOKEN_PROGRAM_ID).length !== (outputAtaExists ? 0 : 1)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_program_validation', 'The swap transaction contains an unsupported outer instruction.');
  const signerCount = transaction.message.header.numRequiredSignatures; const signers = transaction.message.staticAccountKeys.slice(0, signerCount).map(String);
  if (signerCount !== 2 || signers[0] !== payer || signers[1] !== wallet) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_program_validation', 'The swap transaction requested an unexpected signer.');
  if (!innerGroups?.length) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_program_validation', 'The swap CPI programs could not be proven.');
  let directDexInvocations = 0;
  for (const group of innerGroups) {
    const parent = outerPrograms[group.index]; if (!parent) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_program_validation', 'The swap CPI parent could not be proven.');
    for (const instruction of group.instructions) {
      const program = instruction.programId ?? (instruction.programIdIndex === undefined ? undefined : keys[instruction.programIdIndex]);
      if (!program || !allowed.has(program)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_program_validation', 'The swap route invoked an unsupported program.');
      if (dexPrograms.has(program)) {
        if (program !== expectedDexProgram || parent !== JUPITER_SWAP_PROGRAM_ID || ![2, 3].includes(instruction.stackHeight ?? -1)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_program_validation', 'The approved DEX invocation has an invalid program or parent.');
        if (instruction.stackHeight === 2) directDexInvocations += 1;
      }
      if (program === PUMP_FEE_PROGRAM_ID && (family !== 'Pump.fun Amm' || parent !== JUPITER_SWAP_PROGRAM_ID || instruction.stackHeight !== 3)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_program_validation', 'The PumpSwap fee invocation has an invalid parent.');
      if (program === SYSTEM_PROGRAM_ID && (parent !== ASSOCIATED_TOKEN_PROGRAM_ID || instruction.stackHeight !== 2 || outputAtaExists)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_program_validation', 'The swap contains an unsafe account-creation invocation.');
    }
  }
  if (directDexInvocations !== 1) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_program_validation', 'The route must invoke exactly one approved DEX family directly from Jupiter.');
}

export function buildSwapTransaction(input: { swap: SwapQuoteDetails; build: JupiterBuild; walletAddress: string; feePayer: string; computeUnitLimit?: number }) {
  const suppliedCompute = input.build.computeBudgetInstructions.filter((instruction) => Buffer.from(instruction.data, 'base64')[0] !== 2).map(jupiterInstruction);
  const outputSetup = input.build.setupInstructions.filter((instruction) => instruction.accounts[1]?.pubkey === input.swap.outputAccount);
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit ?? MAX_COMPUTE_UNITS }), ...suppliedCompute, ...(!input.swap.outputAtaExists ? outputSetup.map(jupiterInstruction) : []), jupiterInstruction(input.build.swapInstruction), transferChecked(input.swap.inputToken.sourceAccount, input.swap.inputToken.mint, input.swap.reimbursementDestination, input.walletAddress, BigInt(input.swap.sponsorReimbursementRaw), input.swap.inputToken.decimals), transferChecked(input.swap.inputToken.sourceAccount, input.swap.inputToken.mint, input.swap.serviceFeeDestination, input.walletAddress, BigInt(input.swap.serviceFeeRaw), input.swap.inputToken.decimals)];
  const recentBlockhash = new PublicKey(Uint8Array.from(input.build.blockhashWithMetadata.blockhash)).toBase58();
  const message = new TransactionMessage({ payerKey: new PublicKey(input.feePayer), recentBlockhash, instructions }).compileToV0Message(lookupTables(input.build));
  const transaction = new VersionedTransaction(message);
  if (transaction.serialize().length > MAX_SOLANA_TRANSACTION_BYTES) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The approved route does not fit in one Solana transaction.');
  return transaction;
}

function serialized(transaction: VersionedTransaction) { return Buffer.from(transaction.serialize()).toString('base64'); }

export async function estimateSwapNetworkFee(input: { swap: SwapQuoteDetails; build: JupiterBuild; walletAddress: string; feePayer: string; rpc: SolanaRpc }) {
  const transaction = buildSwapTransaction(input);
  const fee = await input.rpc.getFeeForMessage(Buffer.from(transaction.message.serialize()).toString('base64'));
  if (fee === null) throw new GaslessError('RPC_ERROR', 'swap_fee', 'We could not calculate a safe gasless fee right now.', true);
  return BigInt(fee);
}

export async function prepareSwapTransaction(input: { quote: TransactionQuote; swap: SwapQuoteDetails; build: JupiterBuild; feePayer: string; rpc: SolanaRpc }) {
  const required = new Set(input.build.swapInstruction.accounts.map((account) => account.pubkey));
  if (![input.quote.intent.walletAddress, input.swap.inputToken.sourceAccount, input.swap.outputAccount].every((address) => required.has(address))) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The Jupiter route is not bound to the approved wallet and token accounts.');
  const transaction = buildSwapTransaction({ ...input, walletAddress: input.quote.intent.walletAddress });
  const fee = await input.rpc.getFeeForMessage(Buffer.from(transaction.message.serialize()).toString('base64'));
  if (fee === null || String(fee) !== input.swap.networkFeeLamports) throw new GaslessError('RPC_ERROR', 'swap_fee', 'The sponsored network cost changed while preparing this swap.', true);
  const simulationResult = await input.rpc.simulateTransaction(serialized(transaction), false);
  const simulation: SimulationResult = { success: simulationResult.err === null, errorCode: simulationResult.err ? 'SIMULATION_FAILED' : undefined, logs: simulationResult.logs ?? undefined, unitsConsumed: simulationResult.unitsConsumed, provider: simulationResult.provider, simulatedAt: new Date().toISOString() };
  if (!simulation.success) throw new GaslessError('SIMULATION_FAILED', 'pre_signature_simulation', "This swap couldn't be safely prepared. Your tokens have not moved.");
  validateSwapProgramShape(transaction, input.build, simulationResult.innerInstructions, input.swap.outputAtaExists, input.feePayer, input.quote.intent.walletAddress);
  const recentBlockhash = transaction.message.recentBlockhash;
  const prepared: PreparedTransaction = { transactionId: crypto.randomUUID(), quoteId: input.quote.quoteId, intentId: input.quote.intent.intentId, walletAddress: input.quote.intent.walletAddress, network: input.quote.intent.network, serializedTransaction: serialized(transaction), preparedMessageHash: versionedMessageHash(transaction), expectedFeePayer: input.feePayer, expectedSigners: [input.feePayer, input.quote.intent.walletAddress], allowedProgramIds: [...SWAP_ALLOWED_PROGRAM_IDS], recentBlockhash, lastValidBlockHeight: input.build.blockhashWithMetadata.lastValidBlockHeight, simulation };
  return prepared;
}

function validEd25519Signature(message: Uint8Array, publicKey: PublicKey, signature: Uint8Array) { const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey.toBuffer()]); return verify(null, message, createPublicKey({ key: der, format: 'der', type: 'spki' }), signature); }

export async function validateSignedSwap(value: string, prepared: PreparedTransaction, rpc: SolanaRpc): Promise<ValidatedTransaction> {
  let transaction: VersionedTransaction; let preparedTransaction: VersionedTransaction; try { transaction = VersionedTransaction.deserialize(Buffer.from(value, 'base64')); preparedTransaction = VersionedTransaction.deserialize(Buffer.from(prepared.serializedTransaction, 'base64')); } catch { throw new GaslessError('INVALID_REQUEST', 'signed_message_validation', 'The signed swap transaction could not be read.'); }
  const keys = transaction.message.staticAccountKeys;
  const compatible = validatePhantomCompatibleTransaction(preparedTransaction, transaction);
  if (!compatible.accepted || keys[0]?.toBase58() !== prepared.expectedFeePayer || transaction.message.recentBlockhash !== prepared.recentBlockhash) throw new GaslessError('MESSAGE_MISMATCH', 'signed_message_validation', 'This swap changed after the preview. Review it again.');
  const walletIndex = keys.findIndex((key) => key.toBase58() === prepared.walletAddress);
  if (walletIndex < 0 || walletIndex >= transaction.message.header.numRequiredSignatures || !validEd25519Signature(transaction.message.serialize(), keys[walletIndex], transaction.signatures[walletIndex])) throw new GaslessError('USER_SIGNATURE_INVALID', 'signed_message_validation', 'The connected wallet signature is invalid.');
  if (!signingDeadlineIsActive(prepared.walletSigningExpiresAt)) throw new GaslessError('QUOTE_EXPIRED', 'signed_message_validation', 'The signing window closed before submission. Review a fresh quote.');
  if (await rpc.getBlockHeight() > prepared.lastValidBlockHeight) throw new GaslessError('QUOTE_EXPIRED', 'signed_message_validation', 'The price changed while you were reviewing the swap. Refresh your quote.');
  return { transactionId: prepared.transactionId, quoteId: prepared.quoteId, serializedTransaction: value, messageHash: versionedMessageHash(transaction), walletAddress: prepared.walletAddress, validatedAt: new Date().toISOString() };
}
