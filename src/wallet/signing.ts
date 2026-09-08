import { VersionedTransaction } from '@solana/web3.js';
import { validatePhantomCompatibleTransaction } from '../../chains/solana/transactions/phantom.js';

const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export type SafeInstructionSummary = {
  index: number;
  programId: string;
  type: 'SetComputeUnitLimit' | 'SetComputeUnitPrice' | 'CreateIdempotent' | 'TransferChecked' | 'Unknown';
  accountIndexes: number[];
  accountCount: number;
  dataLength: number;
  units?: number;
  microLamports?: string;
  amount?: string;
  decimals?: number;
};

export type SafeTransactionStructure = {
  messageSha256: string;
  messageLength: number;
  transactionVersion: string;
  recentBlockhash: string;
  requiredSignatureCount: number;
  staticAccountKeyCount: number;
  lookupTableCount: number;
  instructionCount: number;
  signerPublicKeys: string[];
  signatureSlotsPopulated: boolean[];
  instructions: SafeInstructionSummary[];
};

export type SafeMutationDifference = {
  kind: 'transaction_version_changed' | 'blockhash_changed' | 'signer_layout_changed' | 'static_key_added' | 'static_key_removed' | 'lookup_tables_changed' | 'instruction_added' | 'instruction_removed' | 'instruction_reordered' | 'instruction_program_changed' | 'instruction_accounts_changed' | 'instruction_data_changed';
  preparedIndex?: number;
  returnedIndex?: number;
  publicKeys?: string[];
};

export type WalletMutationDiagnostics = {
  schemaVersion: 'wallet-mutation-v1';
  compatibilityReason?: string;
  prepared: SafeTransactionStructure;
  returned: SafeTransactionStructure;
  differences: SafeMutationDifference[];
};

export class WalletMessageMismatchError extends Error {
  constructor(public readonly mutationDiagnostics: WalletMutationDiagnostics) {
    super('The wallet changed the prepared transaction. Review a new GASLESS quote.');
    this.name = 'WalletMessageMismatchError';
  }
}

function readU64(data: Uint8Array, offset: number) {
  if (data.length < offset + 8) return undefined;
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true).toString();
}

function summarizeInstruction(index: number, programId: string, accountIndexes: number[], data: Uint8Array): SafeInstructionSummary {
  const base = { index, programId, accountIndexes: [...accountIndexes], accountCount: accountIndexes.length, dataLength: data.length };
  if (programId === COMPUTE_BUDGET_PROGRAM && data[0] === 2 && data.length === 5) return { ...base, type: 'SetComputeUnitLimit', units: new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0, true) };
  if (programId === COMPUTE_BUDGET_PROGRAM && data[0] === 3 && data.length === 9) return { ...base, type: 'SetComputeUnitPrice', microLamports: readU64(data, 1) };
  if (programId === ASSOCIATED_TOKEN_PROGRAM && data[0] === 1 && data.length === 1) return { ...base, type: 'CreateIdempotent' };
  if (programId === LEGACY_TOKEN_PROGRAM && data[0] === 12 && data.length === 10) return { ...base, type: 'TransferChecked', amount: readU64(data, 1), decimals: data[9] };
  return { ...base, type: 'Unknown' };
}

async function sha256(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.length); copy.set(bytes); const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function equalBytes(left: Uint8Array, right: Uint8Array) { return left.length === right.length && left.every((byte, index) => byte === right[index]); }
function instructionFingerprint(programId: string, accounts: number[], data: Uint8Array) { return `${programId}|${accounts.join(',')}|${[...data].join(',')}`; }

async function transactionStructure(transaction: VersionedTransaction): Promise<SafeTransactionStructure> {
  const message = transaction.message; const bytes = message.serialize(); const keys = message.staticAccountKeys.map(String); const signerCount = message.header.numRequiredSignatures;
  return {
    messageSha256: await sha256(bytes), messageLength: bytes.length, transactionVersion: String(transaction.version), recentBlockhash: message.recentBlockhash,
    requiredSignatureCount: signerCount, staticAccountKeyCount: keys.length, lookupTableCount: message.addressTableLookups.length, instructionCount: message.compiledInstructions.length,
    signerPublicKeys: keys.slice(0, signerCount), signatureSlotsPopulated: transaction.signatures.slice(0, signerCount).map((signature) => signature.some((byte) => byte !== 0)),
    instructions: message.compiledInstructions.map((instruction, index) => summarizeInstruction(index, keys[instruction.programIdIndex] ?? 'unknown', [...instruction.accountKeyIndexes], instruction.data)),
  };
}

function mutationDifferences(prepared: VersionedTransaction, returned: VersionedTransaction): SafeMutationDifference[] {
  const differences: SafeMutationDifference[] = []; const before = prepared.message; const after = returned.message;
  const beforeKeys = before.staticAccountKeys.map(String); const afterKeys = after.staticAccountKeys.map(String);
  const beforeSigners = beforeKeys.slice(0, before.header.numRequiredSignatures); const afterSigners = afterKeys.slice(0, after.header.numRequiredSignatures);
  if (prepared.version !== returned.version) differences.push({ kind: 'transaction_version_changed' });
  if (before.recentBlockhash !== after.recentBlockhash) differences.push({ kind: 'blockhash_changed' });
  if (before.header.numRequiredSignatures !== after.header.numRequiredSignatures || beforeSigners.join('|') !== afterSigners.join('|')) differences.push({ kind: 'signer_layout_changed' });
  const added = afterKeys.filter((key) => !beforeKeys.includes(key)); const removed = beforeKeys.filter((key) => !afterKeys.includes(key));
  if (added.length) differences.push({ kind: 'static_key_added', publicKeys: added.slice(0, 32) });
  if (removed.length) differences.push({ kind: 'static_key_removed', publicKeys: removed.slice(0, 32) });
  if (JSON.stringify(before.addressTableLookups) !== JSON.stringify(after.addressTableLookups)) differences.push({ kind: 'lookup_tables_changed' });
  const beforeInstructions = before.compiledInstructions; const afterInstructions = after.compiledInstructions;
  const beforeFingerprints = beforeInstructions.map((instruction) => instructionFingerprint(beforeKeys[instruction.programIdIndex] ?? '', [...instruction.accountKeyIndexes], instruction.data));
  const afterFingerprints = afterInstructions.map((instruction) => instructionFingerprint(afterKeys[instruction.programIdIndex] ?? '', [...instruction.accountKeyIndexes], instruction.data));
  if (afterInstructions.length > beforeInstructions.length) afterFingerprints.forEach((fingerprint, index) => { if (!beforeFingerprints.includes(fingerprint)) differences.push({ kind: 'instruction_added', returnedIndex: index }); });
  if (beforeInstructions.length > afterInstructions.length) beforeFingerprints.forEach((fingerprint, index) => { if (!afterFingerprints.includes(fingerprint)) differences.push({ kind: 'instruction_removed', preparedIndex: index }); });
  for (let index = 0; index < Math.min(beforeInstructions.length, afterInstructions.length); index += 1) {
    const left = beforeInstructions[index]!; const right = afterInstructions[index]!; const reorderedTo = afterFingerprints.indexOf(beforeFingerprints[index]!);
    if (beforeFingerprints[index] !== afterFingerprints[index] && reorderedTo >= 0 && reorderedTo !== index) differences.push({ kind: 'instruction_reordered', preparedIndex: index, returnedIndex: reorderedTo });
    if (beforeKeys[left.programIdIndex] !== afterKeys[right.programIdIndex]) differences.push({ kind: 'instruction_program_changed', preparedIndex: index, returnedIndex: index });
    if ([...left.accountKeyIndexes].join(',') !== [...right.accountKeyIndexes].join(',')) differences.push({ kind: 'instruction_accounts_changed', preparedIndex: index, returnedIndex: index });
    if (!equalBytes(left.data, right.data)) differences.push({ kind: 'instruction_data_changed', preparedIndex: index, returnedIndex: index });
  }
  return differences.slice(0, 64);
}

export async function inspectWalletMutation(preparedBytes: Uint8Array, returnedBytes: Uint8Array): Promise<WalletMutationDiagnostics> {
  const prepared = VersionedTransaction.deserialize(preparedBytes); const returned = VersionedTransaction.deserialize(returnedBytes);
  return { schemaVersion: 'wallet-mutation-v1', prepared: await transactionStructure(prepared), returned: await transactionStructure(returned), differences: mutationDifferences(prepared, returned) };
}

export async function assertExactSignedTransaction(prepared: Uint8Array, signed: Uint8Array) {
  let diagnostics: WalletMutationDiagnostics; let preparedMessage: Uint8Array; let signedMessage: Uint8Array;
  try {
    preparedMessage = VersionedTransaction.deserialize(prepared).message.serialize(); signedMessage = VersionedTransaction.deserialize(signed).message.serialize();
    diagnostics = await inspectWalletMutation(prepared, signed);
  } catch { throw new Error('The wallet returned an invalid Solana transaction.'); }
  if (!equalBytes(preparedMessage, signedMessage)) throw new WalletMessageMismatchError(diagnostics);
  return signed;
}

export async function assertSupportedWalletSignedTransaction(prepared: Uint8Array, signed: Uint8Array) {
  let diagnostics: WalletMutationDiagnostics; let preparedTransaction: VersionedTransaction; let signedTransaction: VersionedTransaction;
  try {
    preparedTransaction = VersionedTransaction.deserialize(prepared); signedTransaction = VersionedTransaction.deserialize(signed);
    diagnostics = await inspectWalletMutation(prepared, signed);
  } catch { throw new Error('The wallet returned an invalid Solana transaction.'); }
  const compatibility = validatePhantomCompatibleTransaction(preparedTransaction, signedTransaction);
  if (!compatibility.accepted) {
    diagnostics.compatibilityReason = compatibility.reason;
    throw new WalletMessageMismatchError(diagnostics);
  }
  return signed;
}
