import { createHash } from 'node:crypto';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import type { PreparedTransaction, SimulationResult, TransactionQuote, ValidatedTransaction } from '../../../shared/transactions/types.js';
import { GaslessError } from '../../../server/errors.js';
import type { SolanaRpc } from '../../../server/solana/rpc.js';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export function messageHash(transaction: Transaction) {
  return createHash('sha256').update(transaction.serializeMessage()).digest('hex');
}

export function buildProofTransaction(quote: TransactionQuote, feePayer: string, blockhash: string) {
  if (quote.intent.network !== 'devnet' || quote.intent.actionType !== 'DEVNET_PROOF') throw new GaslessError('UNSUPPORTED_NETWORK', 'prepare', 'Only the Devnet proof action can be prepared.');
  const wallet = new PublicKey(quote.intent.walletAddress);
  const transaction = new Transaction({ feePayer: new PublicKey(feePayer), recentBlockhash: blockhash });
  transaction.add(new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: wallet, isSigner: true, isWritable: false }],
    data: Buffer.from(`GASLESS_DEVNET_PROOF:${quote.intent.intentId}:${quote.quoteId}`, 'utf8'),
  }));
  return transaction;
}

export async function prepareProofTransaction(quote: TransactionQuote, feePayer: string, rpc: SolanaRpc): Promise<PreparedTransaction> {
  const latest = await rpc.getLatestBlockhash();
  const transaction = buildProofTransaction(quote, feePayer, latest.blockhash);
  const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const simulated = await rpc.simulateTransaction(serialized, false);
  const simulation: SimulationResult = { success: simulated.err === null, errorCode: simulated.err ? 'SIMULATION_FAILED' : undefined, logs: simulated.logs ?? undefined, unitsConsumed: simulated.unitsConsumed, provider: simulated.provider, simulatedAt: new Date().toISOString() };
  if (!simulation.success) throw new GaslessError('SIMULATION_FAILED', 'pre_signature_simulation', 'This transaction did not pass GASLESS safety checks.');
  return { transactionId: crypto.randomUUID(), quoteId: quote.quoteId, intentId: quote.intent.intentId, walletAddress: quote.intent.walletAddress, network: 'devnet', serializedTransaction: serialized, preparedMessageHash: messageHash(transaction), expectedFeePayer: feePayer, expectedSigners: [feePayer, quote.intent.walletAddress], allowedProgramIds: [MEMO_PROGRAM_ID.toBase58()], recentBlockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, simulation };
}

function hasValidSignature(transaction: Transaction, signer: PublicKey) {
  const signature = transaction.signatures.find((item) => item.publicKey.equals(signer))?.signature;
  if (!signature) return false;
  return transaction.verifySignatures(false);
}

export async function validateSignedProof(serialized: string, prepared: PreparedTransaction, rpc: SolanaRpc): Promise<ValidatedTransaction> {
  let transaction: Transaction;
  try { transaction = Transaction.from(Buffer.from(serialized, 'base64')); }
  catch (error) { throw new GaslessError('INVALID_REQUEST', 'signed_message_validation', 'The signed transaction could not be read.', false, undefined, { cause: error }); }
  if (messageHash(transaction) !== prepared.preparedMessageHash) throw new GaslessError('MESSAGE_MISMATCH', 'signed_message_validation', 'The signed transaction does not match the transaction GASLESS prepared.');
  if (transaction.feePayer?.toBase58() !== prepared.expectedFeePayer) throw new GaslessError('MESSAGE_MISMATCH', 'signed_message_validation', 'The fee payer was changed.');
  if (transaction.recentBlockhash !== prepared.recentBlockhash) throw new GaslessError('MESSAGE_MISMATCH', 'signed_message_validation', 'The transaction blockhash was changed.');
  if (transaction.instructions.length !== 1 || !transaction.instructions[0].programId.equals(MEMO_PROGRAM_ID)) throw new GaslessError('MESSAGE_MISMATCH', 'signed_message_validation', 'The transaction instructions were changed.');
  const instruction = transaction.instructions[0];
  if (instruction.keys.length !== 1 || instruction.keys[0].pubkey.toBase58() !== prepared.walletAddress || !instruction.keys[0].isSigner || instruction.keys[0].isWritable) throw new GaslessError('MESSAGE_MISMATCH', 'signed_message_validation', 'The proof signer accounts were changed.');
  const wallet = new PublicKey(prepared.walletAddress);
  if (!hasValidSignature(transaction, wallet)) throw new GaslessError('USER_SIGNATURE_INVALID', 'signed_message_validation', 'The connected wallet signature is invalid.');
  if (await rpc.getBlockHeight() > prepared.lastValidBlockHeight) throw new GaslessError('QUOTE_EXPIRED', 'signed_message_validation', 'This transaction expired. Request a new quote.');
  return { transactionId: prepared.transactionId, quoteId: prepared.quoteId, serializedTransaction: serialized, messageHash: prepared.preparedMessageHash, walletAddress: prepared.walletAddress, validatedAt: new Date().toISOString() };
}
