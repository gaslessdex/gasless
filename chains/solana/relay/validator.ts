import { createHash } from 'node:crypto';
import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { GaslessError } from '../../../server/errors.js';
import type { RpcAccountInfo } from '../../../server/solana/rpc.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, deriveAssociatedTokenAddress, inspectSendTokenAccount } from '../send/accounts.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../claim/accounts.js';
import { relayOrderId, type RelayProtocolOrder } from './order.js';

export const RELAY_DEPOSITORY_PROGRAM_ID = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
export const RELAY_MAINNET_LOOKUP_TABLE = 'Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const ACTIVE_LOOKUP_TABLE_SLOT = (1n << 64n) - 1n;
const NATIVE_DISCRIMINATOR = Buffer.from([13, 158, 13, 223, 95, 213, 28, 6]);
const TOKEN_DISCRIMINATOR = Buffer.from([11, 156, 96, 218, 39, 163, 180, 19]);
const RELAY_SOLVER = '0xf70da97812cb96acdf810712aa562db8dfa3dbef';
const ROBINHOOD_EXTRA_DATA = '0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f';
const INPUT_MINTS = { SOL: SYSTEM_PROGRAM_ID, USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' } as const;
const OUTPUT_MINTS = { ETH: '0x0000000000000000000000000000000000000000', USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' } as const;

export interface RelayInstructionJson {
  programId: string;
  keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}
export interface RelayTransactionData { instructions: RelayInstructionJson[]; addressLookupTableAddresses?: string[] }
export interface RelayValidationQuote {
  requestId?: string;
  steps?: Array<{ kind?: string; requestId?: string; items?: Array<{ data?: RelayTransactionData }> }>;
  details?: { sender?: string; recipient?: string; currencyIn?: { amount?: string; currency?: { chainId?: number; address?: string } }; currencyOut?: { amount?: string; minimumAmount?: string; currency?: { chainId?: number; address?: string } } };
  protocol?: { v2?: { orderId?: string; orderData?: RelayProtocolOrder; paymentDetails?: { chainId?: string; depository?: string; currency?: string; amount?: string } } };
}
export interface RelayValidationRpc {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getFeeForMessage(messageBase64: string): Promise<number | null>;
  getAccountInfo(address: string): Promise<RpcAccountInfo | null>;
  getAddressLookupTable(address: string): Promise<AddressLookupTableAccount | null>;
}
export interface RelayValidationIntent {
  wallet: string;
  quoteId: string;
  relayRequestId: string;
  inputAsset: 'SOL' | 'USDC' | 'USDT';
  inputMint: string;
  inputAmountRaw: string;
  destinationAsset: 'ETH' | 'USDG';
  destinationMint: string;
  recipient: string;
  depositFeePayer: string;
  expiresAt: string;
  maximumSponsoredCostLamports: number;
}
export interface ValidatedRelayTransaction {
  serializedTransaction: string;
  messageHash: string;
  wallet: string;
  quoteId: string;
  relayRequestId: string;
  orderId: string;
  inputAsset: 'SOL' | 'USDC' | 'USDT';
  inputMint: string;
  inputAmountRaw: string;
  destinationAsset: 'ETH' | 'USDG';
  recipient: string;
  depositFeePayer: string;
  expectedSponsorMaxLamports: number;
  expiresAt: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  expectedSourceAccount: string;
  expectedVaultAccount: string;
  validatedAt: string;
}

function reject(stage: string, message = 'Relay returned a transaction that GASLESS cannot safely sponsor.'): never {
  throw new GaslessError('RELAYER_POLICY_REJECTED', stage, message);
}
function publicKey(value: string, stage: string) { try { return new PublicKey(value); } catch { return reject(stage); } }
function sameAddress(left: string | undefined, right: string) { return left?.toLowerCase() === right.toLowerCase(); }
function exactKeys(actual: RelayInstructionJson['keys'], expected: Array<[string, boolean, boolean]>) {
  return actual.length === expected.length && actual.every((key, index) => key.pubkey === expected[index][0] && key.isSigner === expected[index][1] && key.isWritable === expected[index][2]);
}
function decodeInstructionData(hex: string, discriminator: Buffer) {
  if (!/^[0-9a-f]{96}$/.test(hex)) reject('relay_instruction');
  const data = Buffer.from(hex, 'hex');
  if (!data.subarray(0, 8).equals(discriminator)) reject('relay_instruction');
  return { amount: data.readBigUInt64LE(8).toString(), orderId: `0x${data.subarray(16).toString('hex')}` };
}
function relayPdas() {
  const program = new PublicKey(RELAY_DEPOSITORY_PROGRAM_ID);
  return {
    depository: PublicKey.findProgramAddressSync([Buffer.from('relay_depository')], program)[0].toBase58(),
    vault: PublicKey.findProgramAddressSync([Buffer.from('vault')], program)[0].toBase58(),
  };
}
function hashMessage(transaction: VersionedTransaction) { return createHash('sha256').update(transaction.message.serialize()).digest('hex'); }

async function resolveLookupTables(data: RelayTransactionData, rpc: RelayValidationRpc) {
  const addresses = data.addressLookupTableAddresses ?? [];
  if (addresses.length !== 1 || addresses[0] !== RELAY_MAINNET_LOOKUP_TABLE) reject('relay_lookup_table');
  const table = await rpc.getAddressLookupTable(addresses[0]);
  if (!table || table.key.toBase58() !== addresses[0] || table.state.deactivationSlot !== ACTIVE_LOOKUP_TABLE_SLOT || table.state.addresses.length === 0) reject('relay_lookup_table');
  return [table];
}

function assertProtocolUnsafe(quote: RelayValidationQuote, intent: RelayValidationIntent) {
  const protocol = quote.protocol?.v2; const order = protocol?.orderData; const payment = protocol?.paymentDetails;
  if (!protocol?.orderId || !order || !payment) reject('relay_order');
  let computed: string; try { computed = relayOrderId(order); } catch { return reject('relay_order'); }
  if (computed !== protocol.orderId.toLowerCase()) reject('relay_order');
  if (order.version !== 'v1' || order.solverChainId !== 'base' || order.solver.toLowerCase() !== RELAY_SOLVER || order.inputs.length !== 1 || order.inputs[0].refunds.length !== 2 || order.output.payments.length !== 1 || order.output.calls.length !== 0 || order.output.extraData.toLowerCase() !== ROBINHOOD_EXTRA_DATA || order.fees.length !== 0) reject('relay_order');
  const input = order.inputs[0].payment; const output = order.output; const outputPayment = output.payments[0];
  if (input.chainId !== 'solana' || input.currency !== intent.inputMint || input.amount !== intent.inputAmountRaw || input.weight !== '1') reject('relay_input_binding');
  if (!/^\d+$/.test(outputPayment.minimumAmount) || !/^\d+$/.test(outputPayment.expectedAmount) || output.chainId !== 'robinhood' || outputPayment.recipient.toLowerCase() !== intent.recipient.toLowerCase() || outputPayment.currency.toLowerCase() !== intent.destinationMint.toLowerCase() || BigInt(outputPayment.minimumAmount) <= 0n || BigInt(outputPayment.expectedAmount) < BigInt(outputPayment.minimumAmount) || quote.details?.currencyOut?.amount !== outputPayment.expectedAmount || quote.details.currencyOut.minimumAmount !== outputPayment.minimumAmount) reject('relay_recipient_binding');
  if (payment.chainId !== 'solana' || payment.depository !== RELAY_DEPOSITORY_PROGRAM_ID || payment.currency !== intent.inputMint || payment.amount !== intent.inputAmountRaw) reject('relay_payment_binding');
  const originRefund = order.inputs[0].refunds.find((refund) => refund.chainId === 'solana');
  const destinationRefund = order.inputs[0].refunds.find((refund) => refund.chainId === 'robinhood');
  if (!originRefund || originRefund.recipient !== intent.wallet || originRefund.currency !== intent.inputMint || originRefund.minimumAmount !== '0' || originRefund.extraData !== '0x' || originRefund.deadline !== output.deadline || !destinationRefund || destinationRefund.recipient.toLowerCase() !== intent.recipient.toLowerCase() || destinationRefund.currency.toLowerCase() !== intent.destinationMint.toLowerCase() || destinationRefund.minimumAmount !== '0' || destinationRefund.extraData.toLowerCase() !== ROBINHOOD_EXTRA_DATA || destinationRefund.deadline !== output.deadline || !Number.isSafeInteger(output.deadline) || output.deadline <= Date.now() / 1000) reject('relay_refund_binding');
  return protocol.orderId.toLowerCase();
}

function assertProtocol(quote: RelayValidationQuote, intent: RelayValidationIntent) {
  try { return assertProtocolUnsafe(quote, intent); }
  catch (error) { if (error instanceof GaslessError) throw error; return reject('relay_order'); }
}

async function assertInstruction(instruction: RelayInstructionJson, intent: RelayValidationIntent, orderId: string, rpc: RelayValidationRpc) {
  if (instruction.programId !== RELAY_DEPOSITORY_PROGRAM_ID) reject('relay_program');
  const pdas = relayPdas();
  if (intent.inputAsset === 'SOL') {
    const decoded = decodeInstructionData(instruction.data, NATIVE_DISCRIMINATOR);
    if (decoded.amount !== intent.inputAmountRaw || decoded.orderId !== orderId || !exactKeys(instruction.keys, [
      [pdas.depository, false, false], [intent.wallet, true, true], [intent.wallet, false, false], [pdas.vault, false, true], [SYSTEM_PROGRAM_ID, false, false],
    ])) reject('relay_native_deposit');
    return;
  }
  const decoded = decodeInstructionData(instruction.data, TOKEN_DISCRIMINATOR);
  const source = deriveAssociatedTokenAddress(intent.wallet, intent.inputMint, LEGACY_TOKEN_PROGRAM_ID);
  const vaultToken = deriveAssociatedTokenAddress(pdas.vault, intent.inputMint, LEGACY_TOKEN_PROGRAM_ID);
  if (decoded.amount !== intent.inputAmountRaw || decoded.orderId !== orderId || !exactKeys(instruction.keys, [
    [pdas.depository, false, false], [intent.wallet, true, true], [intent.wallet, false, false], [pdas.vault, false, false], [intent.inputMint, false, false], [source, false, true], [vaultToken, false, true], [LEGACY_TOKEN_PROGRAM_ID, false, false], [ASSOCIATED_TOKEN_PROGRAM_ID, false, false], [SYSTEM_PROGRAM_ID, false, false],
  ])) reject('relay_token_deposit');
  const account = await rpc.getAccountInfo(source);
  const token = inspectSendTokenAccount(source, account, intent.wallet, { mint: intent.inputMint, symbol: intent.inputAsset, decimals: 6, tokenProgram: LEGACY_TOKEN_PROGRAM_ID, extensions: [], status: 'supported', enabledActions: ['SEND'], feePaymentEnabled: true });
  if (!token || BigInt(token.balanceRaw) < BigInt(intent.inputAmountRaw)) reject('relay_token_account');
}

function assertResolvedMessage(transaction: VersionedTransaction, instruction: RelayInstructionJson, tables: AddressLookupTableAccount[], intent: RelayValidationIntent) {
  const message = transaction.message;
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables });
  if (message.header.numRequiredSignatures !== 2 || message.staticAccountKeys[0]?.toBase58() !== intent.depositFeePayer || message.staticAccountKeys[1]?.toBase58() !== intent.wallet || message.compiledInstructions.length !== 1 || keys.length !== message.staticAccountKeys.length + (keys.accountKeysFromLookups?.writable.length ?? 0) + (keys.accountKeysFromLookups?.readonly.length ?? 0)) reject('relay_message');
  if (message.addressTableLookups.length !== tables.length || message.addressTableLookups[0].accountKey.toBase58() !== RELAY_MAINNET_LOOKUP_TABLE) reject('relay_lookup_table');
  const compiled = message.compiledInstructions[0];
  if (keys.get(compiled.programIdIndex)?.toBase58() !== instruction.programId || compiled.accountKeyIndexes.length !== instruction.keys.length || !Buffer.from(compiled.data).equals(Buffer.from(instruction.data, 'hex'))) reject('relay_message');
  instruction.keys.forEach((expected, index) => {
    const accountIndex = compiled.accountKeyIndexes[index];
    const effectiveSigner = instruction.keys.some((key) => key.pubkey === expected.pubkey && key.isSigner);
    const effectiveWritable = instruction.keys.some((key) => key.pubkey === expected.pubkey && key.isWritable);
    if (keys.get(accountIndex)?.toBase58() !== expected.pubkey || message.isAccountSigner(accountIndex) !== effectiveSigner || message.isAccountWritable(accountIndex) !== effectiveWritable) reject('relay_message');
  });
  if (instruction.keys.some((key) => key.pubkey === intent.depositFeePayer)) reject('relay_sponsor_boundary');
}

export async function validateRelayTransaction(quote: RelayValidationQuote, intent: RelayValidationIntent, rpc: RelayValidationRpc): Promise<ValidatedRelayTransaction> {
  publicKey(intent.wallet, 'relay_user'); publicKey(intent.depositFeePayer, 'relay_fee_payer'); publicKey(intent.inputMint, 'relay_input');
  const expiry = Date.parse(intent.expiresAt);
  if (INPUT_MINTS[intent.inputAsset] !== intent.inputMint || OUTPUT_MINTS[intent.destinationAsset] !== intent.destinationMint.toLowerCase() || intent.wallet === intent.depositFeePayer || !/^0x[0-9a-fA-F]{40}$/.test(intent.recipient) || !Number.isSafeInteger(intent.maximumSponsoredCostLamports) || intent.maximumSponsoredCostLamports < 1 || !Number.isFinite(expiry) || expiry <= Date.now()) reject('relay_intent');
  if (quote.requestId !== intent.relayRequestId || quote.details?.sender !== intent.wallet || !sameAddress(quote.details?.recipient, intent.recipient) || quote.details?.currencyIn?.amount !== intent.inputAmountRaw || quote.details.currencyIn.currency?.chainId !== 792703809 || quote.details.currencyIn.currency.address !== intent.inputMint || quote.details.currencyOut?.currency?.chainId !== 4663 || !sameAddress(quote.details.currencyOut.currency.address, intent.destinationMint)) reject('relay_quote_binding');
  const orderId = assertProtocol(quote, intent);
  const steps = quote.steps ?? []; const step = steps[0]; const item = step?.items?.[0];
  if (steps.length !== 1 || step.kind !== 'transaction' || step.requestId !== intent.relayRequestId || step.items?.length !== 1 || !item?.data || item.data.instructions.length !== 1) reject('relay_steps');
  await assertInstruction(item.data.instructions[0], intent, orderId, rpc);
  const tables = await resolveLookupTables(item.data, rpc);
  const latest = await rpc.getLatestBlockhash();
  const instruction = new TransactionInstruction({ programId: new PublicKey(item.data.instructions[0].programId), keys: item.data.instructions[0].keys.map((key) => ({ ...key, pubkey: new PublicKey(key.pubkey) })), data: Buffer.from(item.data.instructions[0].data, 'hex') });
  const message = new TransactionMessage({ payerKey: new PublicKey(intent.depositFeePayer), recentBlockhash: latest.blockhash, instructions: [instruction] }).compileToV0Message(tables);
  const transaction = new VersionedTransaction(message);
  assertResolvedMessage(transaction, item.data.instructions[0], tables, intent);
  const fee = await rpc.getFeeForMessage(Buffer.from(message.serialize()).toString('base64'));
  if (fee === null || !Number.isSafeInteger(fee) || fee < 1 || fee > intent.maximumSponsoredCostLamports) reject('relay_sponsor_exposure');
  const vault = relayPdas().vault;
  return { serializedTransaction: Buffer.from(transaction.serialize()).toString('base64'), messageHash: hashMessage(transaction), wallet: intent.wallet, quoteId: intent.quoteId, relayRequestId: intent.relayRequestId, orderId, inputAsset: intent.inputAsset, inputMint: intent.inputMint, inputAmountRaw: intent.inputAmountRaw, destinationAsset: intent.destinationAsset, recipient: intent.recipient.toLowerCase(), depositFeePayer: intent.depositFeePayer, expectedSponsorMaxLamports: fee, expiresAt: intent.expiresAt, recentBlockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, expectedSourceAccount: intent.inputAsset === 'SOL' ? intent.wallet : deriveAssociatedTokenAddress(intent.wallet, intent.inputMint), expectedVaultAccount: intent.inputAsset === 'SOL' ? vault : deriveAssociatedTokenAddress(vault, intent.inputMint), validatedAt: new Date().toISOString() };
}

export function assertRelaySimulation(simulation: { err: unknown; logs: string[] | null; innerInstructions?: Array<{ instructions: Array<{ programId?: string; parsed?: { type?: string; info?: Record<string, unknown> } }> }> | null }, validated: ValidatedRelayTransaction) {
  if (simulation.err !== null || !simulation.logs?.some((line) => line.includes(`Program ${RELAY_DEPOSITORY_PROGRAM_ID} success`))) reject('relay_simulation');
  const inner = (simulation.innerInstructions ?? []).flatMap((group) => group.instructions);
  if (inner.length !== 1) reject('relay_simulation_cpi');
  const instruction = inner[0]; const info = instruction.parsed?.info;
  if (validated.inputAsset === 'SOL') {
    if (instruction.programId !== SYSTEM_PROGRAM_ID || instruction.parsed?.type !== 'transfer' || info?.source !== validated.expectedSourceAccount || info.destination !== validated.expectedVaultAccount || String(info.lamports) !== validated.inputAmountRaw) reject('relay_simulation_cpi');
  } else if (instruction.programId !== LEGACY_TOKEN_PROGRAM_ID || instruction.parsed?.type !== 'transferChecked' || info?.source !== validated.expectedSourceAccount || info.destination !== validated.expectedVaultAccount || info.authority !== validated.wallet || info.mint !== validated.inputMint || String((info.tokenAmount as { amount?: unknown } | undefined)?.amount) !== validated.inputAmountRaw) reject('relay_simulation_cpi');
}
