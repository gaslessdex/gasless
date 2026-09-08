import { createPublicKey, verify } from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { PreparedTransaction, SendQuoteDetails, SimulationResult, TransactionQuote, ValidatedTransaction } from '../../../shared/transactions/types.js';
import { GaslessError } from '../../../server/errors.js';
import type { SolanaRpc } from '../../../server/solana/rpc.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '../send/accounts.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../claim/accounts.js';
import { TOKEN_2022_PROGRAM } from '../token-registry/types.js';
import { createToken2022TransferChecked } from '../token-2022/transfer-hook.js';
import { versionedMessageHash } from './clean.js';
import { PHANTOM_LIGHTHOUSE_PROGRAM_ID, validatePhantomCompatibleTransaction } from './phantom.js';

const BPS_DENOMINATOR = 10_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
export const SEND_COMPUTE_UNIT_LIMIT = 200_000;
export const SEND_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 375_000n;
export const SEND_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = SEND_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
function ceilDiv(value: bigint, divisor: bigint) { return value === 0n ? 0n : (value + divisor - 1n) / divisor; }

export function calculateSendPriorityFeeLamports(microLamports = SEND_COMPUTE_UNIT_PRICE_MICROLAMPORTS, units = SEND_COMPUTE_UNIT_LIMIT) {
  if (microLamports <= 0n || microLamports > SEND_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS || !Number.isSafeInteger(units) || units <= 0 || units > SEND_COMPUTE_UNIT_LIMIT) throw new GaslessError('CONFIGURATION_ERROR', 'send_compute_budget', 'Send compute-budget policy is invalid.');
  return ceilDiv(BigInt(units) * microLamports, 1_000_000n);
}

export function calculateSendServiceFee(amountRaw: bigint, decimals: number, tokenUsdPriceMicros: bigint, feeBps = 10, capUsdMicros = 1_000_000n) {
  if (amountRaw < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000 || tokenUsdPriceMicros <= 0n || capUsdMicros < 0n) throw new GaslessError('CONFIGURATION_ERROR', 'send_economics', 'Send fee policy is invalid.');
  const percentageFee = amountRaw * BigInt(feeBps) / BPS_DENOMINATOR;
  const capRaw = capUsdMicros * 10n ** BigInt(decimals) / tokenUsdPriceMicros;
  return percentageFee < capRaw ? percentageFee : capRaw;
}

export function calculateSponsorReimbursement(sponsoredLamports: bigint, decimals: number, solUsdPriceMicros: bigint, tokenUsdPriceMicros: bigint, bufferBps = 0) {
  if (sponsoredLamports < 0n || solUsdPriceMicros <= 0n || tokenUsdPriceMicros <= 0n || !Number.isInteger(bufferBps) || bufferBps < 0 || bufferBps > 10_000) throw new GaslessError('CONFIGURATION_ERROR', 'send_economics', 'Send reimbursement policy is invalid.');
  const raw = ceilDiv(sponsoredLamports * solUsdPriceMicros * 10n ** BigInt(decimals), LAMPORTS_PER_SOL * tokenUsdPriceMicros);
  return ceilDiv(raw * (BPS_DENOMINATOR + BigInt(bufferBps)), BPS_DENOMINATOR);
}

export function calculateSendMax(balanceRaw: bigint, reimbursementRaw: bigint, decimals: number, tokenUsdPriceMicros: bigint, feeBps = 10, capUsdMicros = 1_000_000n) {
  if (balanceRaw <= reimbursementRaw) throw new GaslessError('TOKEN_UNSUPPORTED', 'send_balance', 'You need a little more token balance to cover the GASLESS fee and sponsored network cost.');
  let low = 0n; let high = balanceRaw - reimbursementRaw;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    const debit = middle + reimbursementRaw + calculateSendServiceFee(middle, decimals, tokenUsdPriceMicros, feeBps, capUsdMicros);
    if (debit <= balanceRaw) low = middle; else high = middle - 1n;
  }
  if (low <= 0n) throw new GaslessError('TOKEN_UNSUPPORTED', 'send_balance', 'This balance is too small for a gasless Send.');
  return low;
}

function transferChecked(source: string, mint: string, destination: string, owner: string, amount: bigint, decimals: number) {
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = decimals;
  return new TransactionInstruction({ programId: new PublicKey(LEGACY_TOKEN_PROGRAM_ID), keys: [
    { pubkey: new PublicKey(source), isSigner: false, isWritable: true }, { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(destination), isSigner: false, isWritable: true }, { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
  ], data });
}

function createAtaIdempotent(payer: string, ata: string, owner: string, mint: string, tokenProgram: string) {
  return new TransactionInstruction({ programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID), keys: [
    { pubkey: new PublicKey(payer), isSigner: true, isWritable: true }, { pubkey: new PublicKey(ata), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(owner), isSigner: false, isWritable: false }, { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: new PublicKey(tokenProgram), isSigner: false, isWritable: false },
  ], data: Buffer.from([1]) });
}

export async function buildSendTransaction(input: { send: SendQuoteDetails; walletAddress: string; feePayer: string; blockhash: string; recipientAmount: bigint; reimbursement: bigint; serviceFee: bigint; computeUnitPriceMicroLamports?: bigint; rpc?: Pick<SolanaRpc, 'getAccountInfo'> }) {
  const computeUnitPrice = input.computeUnitPriceMicroLamports ?? SEND_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
  calculateSendPriorityFeeLamports(computeUnitPrice);
  const tokenProgram = input.send.token.tokenProgram;
  if (tokenProgram !== LEGACY_TOKEN_PROGRAM_ID && tokenProgram !== TOKEN_2022_PROGRAM) throw new GaslessError('TOKEN_UNSUPPORTED', 'send_token_program', 'This token program is not supported for Send.');
  const transfer = async (destination: string, amount: bigint) => {
    if (tokenProgram === LEGACY_TOKEN_PROGRAM_ID) return transferChecked(input.send.token.sourceAccount, input.send.token.mint, destination, input.walletAddress, amount, input.send.token.decimals);
    if (!input.rpc) throw new GaslessError('CONFIGURATION_ERROR', 'send_token_program', 'Token-2022 Send requires live mint validation.');
    try {
      return (await createToken2022TransferChecked({
        rpc: input.rpc,
        source: input.send.token.sourceAccount,
        mint: input.send.token.mint,
        destination,
        owner: input.walletAddress,
        amount,
        decimals: input.send.token.decimals,
        approvedHookProgramId: null,
      })).instruction;
    } catch {
      throw new GaslessError('TOKEN_UNSUPPORTED', 'send_transfer_hook', 'This Token-2022 transfer profile changed and is not supported for Send.');
    }
  };
  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: SEND_COMPUTE_UNIT_LIMIT }),
    ...(!input.send.recipientAtaExists ? [createAtaIdempotent(input.feePayer, input.send.destinationAccount, input.send.recipientWallet, input.send.token.mint, tokenProgram)] : []),
    await transfer(input.send.destinationAccount, input.recipientAmount),
    await transfer(input.send.reimbursementDestination, input.reimbursement),
    await transfer(input.send.serviceFeeDestination, input.serviceFee),
  ];
  const message = new TransactionMessage({ payerKey: new PublicKey(input.feePayer), recentBlockhash: input.blockhash, instructions }).compileToV0Message();
  return new VersionedTransaction(message);
}

export async function prepareSendTransaction(input: { quote: TransactionQuote; send: SendQuoteDetails; feePayer: string; rpc: SolanaRpc; ataRentLamports: bigint; tokenUsdPriceMicros: bigint; solUsdPriceMicros: bigint; reimbursementBufferBps: number; serviceFeeBps: number; serviceFeeCapUsdMicros: bigint; maximumSponsoredCostLamports: bigint }) {
  const tokenProgram = input.send.token.tokenProgram;
  const blockhashStarted = Date.now(); const latest = await input.rpc.getLatestBlockhash(); const blockhashFetchedAt = new Date().toISOString(); const blockhashMs = Date.now() - blockhashStarted;
  const estimateBuildStarted = Date.now();
  const estimate = await buildSendTransaction({ send: input.send, walletAddress: input.quote.intent.walletAddress, feePayer: input.feePayer, blockhash: latest.blockhash, recipientAmount: input.send.max ? 1n : BigInt(input.send.recipientAmountRaw), reimbursement: 0n, serviceFee: 0n, rpc: input.rpc });
  let transactionConstructionMs = Date.now() - estimateBuildStarted;
  const estimateFeeStarted = Date.now(); const fee = await input.rpc.getFeeForMessage(Buffer.from(estimate.message.serialize()).toString('base64')); let feeCalculationMs = Date.now() - estimateFeeStarted;
  if (fee === null) throw new GaslessError('RPC_ERROR', 'send_fee', 'We could not calculate a safe gasless fee right now.', true);
  if (BigInt(fee) < calculateSendPriorityFeeLamports()) throw new GaslessError('RPC_ERROR', 'send_fee', 'The RPC returned an incomplete sponsored network cost.', true);
  const sponsored = BigInt(fee) + input.ataRentLamports;
  if (sponsored > input.maximumSponsoredCostLamports) throw new GaslessError('RELAYER_POLICY_REJECTED', 'send_sponsor_cost', 'This Send exceeds the GASLESS sponsorship limit.');
  const reimbursement = calculateSponsorReimbursement(sponsored, input.send.token.decimals, input.solUsdPriceMicros, input.tokenUsdPriceMicros, input.reimbursementBufferBps);
  const recipientAmount = input.send.max ? calculateSendMax(BigInt(input.send.token.balanceRaw), reimbursement, input.send.token.decimals, input.tokenUsdPriceMicros, input.serviceFeeBps, input.serviceFeeCapUsdMicros) : BigInt(input.send.recipientAmountRaw);
  const serviceFee = calculateSendServiceFee(recipientAmount, input.send.token.decimals, input.tokenUsdPriceMicros, input.serviceFeeBps, input.serviceFeeCapUsdMicros);
  const total = recipientAmount + reimbursement + serviceFee;
  if (recipientAmount <= 0n || total > BigInt(input.send.token.balanceRaw)) throw new GaslessError('TOKEN_UNSUPPORTED', 'send_balance', `You need a little more ${input.send.token.symbol} to cover the amount, GASLESS fee, and sponsored network cost.`);
  const exactBuildStarted = Date.now(); const transaction = await buildSendTransaction({ send: input.send, walletAddress: input.quote.intent.walletAddress, feePayer: input.feePayer, blockhash: latest.blockhash, recipientAmount, reimbursement, serviceFee, rpc: input.rpc }); const transactionBuiltAt = new Date().toISOString(); transactionConstructionMs += Date.now() - exactBuildStarted;
  const exactFeeStarted = Date.now(); const exactFee = await input.rpc.getFeeForMessage(Buffer.from(transaction.message.serialize()).toString('base64')); feeCalculationMs += Date.now() - exactFeeStarted;
  if (exactFee !== fee) throw new GaslessError('RPC_ERROR', 'send_fee', 'The sponsored network cost changed while preparing Send.', true);
  const serialized = Buffer.from(transaction.serialize()).toString('base64');
  const simulationStarted = Date.now(); const simulated = await input.rpc.simulateTransaction(serialized, false); const simulationCompletedAt = new Date().toISOString(); const simulationMs = Date.now() - simulationStarted;
  const simulation: SimulationResult = { success: simulated.err === null, errorCode: simulated.err ? 'SIMULATION_FAILED' : undefined, logs: simulated.logs ?? undefined, unitsConsumed: simulated.unitsConsumed, provider: simulated.provider, simulatedAt: new Date().toISOString() };
  if (!simulation.success) throw new GaslessError('SIMULATION_FAILED', 'pre_signature_simulation', "This Send couldn't be safely prepared. Your tokens have not moved.");
  const prepared: PreparedTransaction = { transactionId: crypto.randomUUID(), quoteId: input.quote.quoteId, intentId: input.quote.intent.intentId, walletAddress: input.quote.intent.walletAddress, network: input.quote.intent.network, serializedTransaction: serialized, preparedMessageHash: versionedMessageHash(transaction), expectedFeePayer: input.feePayer, expectedSigners: [input.feePayer, input.quote.intent.walletAddress], allowedProgramIds: [ComputeBudgetProgram.programId.toBase58(), tokenProgram, ...(input.send.recipientAtaExists ? [] : [ASSOCIATED_TOKEN_PROGRAM_ID])], recentBlockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, simulation };
  return { prepared, recipientAmount, reimbursement, serviceFee, total, networkFeeLamports: BigInt(fee), sponsoredCostLamports: sponsored, timings: { blockhashMs, transactionConstructionMs, feeCalculationMs, simulationMs, blockhashFetchedAt, transactionBuiltAt, simulationCompletedAt } };
}

export async function validateSignedSend(serialized: string, prepared: PreparedTransaction, rpc: SolanaRpc): Promise<ValidatedTransaction> {
  let transaction: VersionedTransaction; let preparedTransaction: VersionedTransaction; try { transaction = VersionedTransaction.deserialize(Buffer.from(serialized, 'base64')); preparedTransaction = VersionedTransaction.deserialize(Buffer.from(prepared.serializedTransaction, 'base64')); } catch { throw new GaslessError('INVALID_REQUEST', 'signed_message_validation', 'The signed Send transaction could not be read.'); }
  const keys = transaction.message.staticAccountKeys; const signerCount = transaction.message.header.numRequiredSignatures; const signers = keys.slice(0, signerCount).map(String);
  const programs = transaction.message.compiledInstructions.map((instruction) => keys[instruction.programIdIndex]?.toBase58());
  const compatible = validatePhantomCompatibleTransaction(preparedTransaction, transaction);
  if (!compatible.accepted || transaction.version !== 0 || transaction.message.addressTableLookups.length !== 0 || transaction.message.recentBlockhash !== prepared.recentBlockhash || signerCount !== 2 || signers[0] !== prepared.expectedFeePayer || signers[1] !== prepared.walletAddress || programs.some((program) => !program || (!prepared.allowedProgramIds.includes(program) && program !== PHANTOM_LIGHTHOUSE_PROGRAM_ID))) throw new GaslessError('MESSAGE_MISMATCH', 'signed_message_validation', 'Send changed after the preview. Review it again.');
  const payerSignatureEmpty = transaction.signatures[0]?.every((byte) => byte === 0) === true; const walletSignature = transaction.signatures[1];
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(prepared.walletAddress).toBuffer()]);
  if (!payerSignatureEmpty || !walletSignature || !verify(null, transaction.message.serialize(), createPublicKey({ key: der, format: 'der', type: 'spki' }), walletSignature)) throw new GaslessError('USER_SIGNATURE_INVALID', 'signed_message_validation', 'The connected wallet signature is invalid.');
  if (await rpc.getBlockHeight() > prepared.lastValidBlockHeight) throw new GaslessError('QUOTE_EXPIRED', 'signed_message_validation', 'Your Send quote expired. Refresh the costs and review them again.');
  return { transactionId: prepared.transactionId, quoteId: prepared.quoteId, serializedTransaction: serialized, messageHash: versionedMessageHash(transaction), walletAddress: prepared.walletAddress, validatedAt: new Date().toISOString() };
}
