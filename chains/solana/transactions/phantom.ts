import { ComputeBudgetProgram, VersionedTransaction } from '@solana/web3.js';

export const PHANTOM_LIGHTHOUSE_PROGRAM_ID = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';

const MAX_LIGHTHOUSE_ASSERTIONS = 4;
const MAX_LIGHTHOUSE_DATA_BYTES = 256;
const ASSERTION_ACCOUNT_COUNTS: Readonly<Record<number, number>> = {
  2: 1, 3: 1, 4: 2, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1,
  11: 1, 12: 1, 13: 1, 14: 1, 15: 0, 16: 3, 17: 1,
};

type CompiledInstruction = VersionedTransaction['message']['compiledInstructions'][number];

export type PhantomCompatibilityResult =
  | { accepted: true; augmented: boolean }
  | { accepted: false; reason: string };

export function phantomLighthouseAssertionSummaries(transaction: VersionedTransaction) {
  return transaction.message.compiledInstructions.flatMap((instruction) => {
    const program = transaction.message.staticAccountKeys[instruction.programIdIndex]?.toBase58();
    return program === PHANTOM_LIGHTHOUSE_PROGRAM_ID ? [{ discriminator: instruction.data[0] ?? -1, dataLength: instruction.data.length, accountCount: instruction.accountKeyIndexes.length }] : [];
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function sameNumbers(left: readonly number[], right: readonly number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function staticPrivilege(transaction: VersionedTransaction, index: number) {
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = transaction.message.header;
  const staticCount = transaction.message.staticAccountKeys.length;
  const signer = index < numRequiredSignatures;
  const writable = signer
    ? index < numRequiredSignatures - numReadonlySignedAccounts
    : index < staticCount - numReadonlyUnsignedAccounts;
  return `${signer ? 's' : '-'}${writable ? 'w' : 'r'}`;
}

function lookupIdentity(transaction: VersionedTransaction, combinedIndex: number) {
  let offset = transaction.message.staticAccountKeys.length;
  for (const lookup of transaction.message.addressTableLookups) {
    if (combinedIndex < offset + lookup.writableIndexes.length) return `lookup:${lookup.accountKey}:w:${lookup.writableIndexes[combinedIndex - offset]}`;
    offset += lookup.writableIndexes.length;
  }
  for (const lookup of transaction.message.addressTableLookups) {
    if (combinedIndex < offset + lookup.readonlyIndexes.length) return `lookup:${lookup.accountKey}:r:${lookup.readonlyIndexes[combinedIndex - offset]}`;
    offset += lookup.readonlyIndexes.length;
  }
  return undefined;
}

function accountIdentity(transaction: VersionedTransaction, index: number) {
  return index < transaction.message.staticAccountKeys.length
    ? `static:${transaction.message.staticAccountKeys[index]}`
    : lookupIdentity(transaction, index);
}

function instructionIdentity(transaction: VersionedTransaction, instruction: CompiledInstruction) {
  const program = transaction.message.staticAccountKeys[instruction.programIdIndex]?.toBase58();
  const accounts = [...instruction.accountKeyIndexes].map((index) => accountIdentity(transaction, index));
  if (!program || accounts.some((account) => !account)) return undefined;
  return { program, accounts: accounts as string[], data: instruction.data };
}

function sameInstruction(leftTransaction: VersionedTransaction, left: CompiledInstruction, rightTransaction: VersionedTransaction, right: CompiledInstruction) {
  const leftIdentity = instructionIdentity(leftTransaction, left);
  const rightIdentity = instructionIdentity(rightTransaction, right);
  return Boolean(leftIdentity && rightIdentity
    && leftIdentity.program === rightIdentity.program
    && leftIdentity.accounts.join('|') === rightIdentity.accounts.join('|')
    && sameBytes(leftIdentity.data, rightIdentity.data));
}

function computeKind(transaction: VersionedTransaction, instruction: CompiledInstruction) {
  const identity = instructionIdentity(transaction, instruction);
  if (identity?.program !== ComputeBudgetProgram.programId.toBase58() || identity.accounts.length !== 0) return undefined;
  if (identity.data.length === 5 && identity.data[0] === 2) return 'limit' as const;
  if (identity.data.length === 9 && identity.data[0] === 3) return 'price' as const;
  return 'unsupported' as const;
}

function sameLookups(prepared: VersionedTransaction, returned: VersionedTransaction) {
  const left = prepared.message.addressTableLookups;
  const right = returned.message.addressTableLookups;
  return left.length === right.length && left.every((lookup, index) => {
    const candidate = right[index];
    return candidate && lookup.accountKey.equals(candidate.accountKey)
      && sameNumbers(lookup.writableIndexes, candidate.writableIndexes)
      && sameNumbers(lookup.readonlyIndexes, candidate.readonlyIndexes);
  });
}

function lighthouseAssertionIsSupported(transaction: VersionedTransaction, instruction: CompiledInstruction, preparedStaticKeys: Set<string>) {
  const identity = instructionIdentity(transaction, instruction);
  if (!identity || identity.program !== PHANTOM_LIGHTHOUSE_PROGRAM_ID) return false;
  const discriminator = identity.data[0];
  const expectedAccounts = discriminator === undefined ? undefined : ASSERTION_ACCOUNT_COUNTS[discriminator];
  if (expectedAccounts === undefined || identity.accounts.length !== expectedAccounts) return false;
  // A valid Borsh assertion contains at least the enum discriminator, log level,
  // and an assertion discriminator/value. The program performs the full decode.
  if (identity.data.length < 3 || identity.data.length > MAX_LIGHTHOUSE_DATA_BYTES) return false;
  return identity.accounts.every((account) => account.startsWith('lookup:') || preparedStaticKeys.has(account.slice('static:'.length)));
}

/**
 * Accepts byte-exact wallet output, or Phantom's observed narrow normalization:
 * LIMIT/PRICE ordering, with or without appended immutable Lighthouse assertions.
 */
export function validatePhantomCompatibleTransaction(prepared: VersionedTransaction, returned: VersionedTransaction): PhantomCompatibilityResult {
  if (sameBytes(prepared.message.serialize(), returned.message.serialize())) return { accepted: true, augmented: false };
  if (prepared.version !== 0 || returned.version !== 0) return { accepted: false, reason: 'transaction_version_changed' };
  if (prepared.message.recentBlockhash !== returned.message.recentBlockhash) return { accepted: false, reason: 'blockhash_changed' };
  if (!sameLookups(prepared, returned)) return { accepted: false, reason: 'lookup_tables_changed' };

  const preparedKeys = prepared.message.staticAccountKeys.map(String);
  const returnedKeys = returned.message.staticAccountKeys.map(String);
  const newKeys = returnedKeys.filter((key) => !preparedKeys.includes(key));
  const hasLighthouse = newKeys.length === 1 && newKeys[0] === PHANTOM_LIGHTHOUSE_PROGRAM_ID;
  if (newKeys.length > 0 && !hasLighthouse) return { accepted: false, reason: 'unsupported_static_key_change' };
  const expectedReturnedKeyCount = preparedKeys.length + (hasLighthouse ? 1 : 0);
  if (returnedKeys.length !== expectedReturnedKeyCount
    || new Set(returnedKeys).size !== returnedKeys.length
    || !preparedKeys.every((key) => returnedKeys.includes(key))) return { accepted: false, reason: 'static_key_layout_changed' };
  for (const key of preparedKeys) {
    const before = preparedKeys.indexOf(key); const after = returnedKeys.indexOf(key);
    if (staticPrivilege(prepared, before) !== staticPrivilege(returned, after)) return { accepted: false, reason: 'account_privilege_changed' };
  }
  if (hasLighthouse) {
    const lighthouseIndex = returnedKeys.indexOf(PHANTOM_LIGHTHOUSE_PROGRAM_ID);
    if (staticPrivilege(returned, lighthouseIndex) !== '-r') return { accepted: false, reason: 'lighthouse_privilege_invalid' };
  }

  const preparedInstructions = prepared.message.compiledInstructions;
  const returnedInstructions = returned.message.compiledInstructions;
  const preparedCompute = preparedInstructions.filter((instruction) => computeKind(prepared, instruction));
  const returnedCompute = returnedInstructions.filter((instruction) => computeKind(returned, instruction));
  if (preparedCompute.length !== 2 || returnedCompute.length !== 2) return { accepted: false, reason: 'compute_instruction_count_changed' };
  if (preparedCompute.some((instruction) => computeKind(prepared, instruction) === 'unsupported') || returnedCompute.some((instruction) => computeKind(returned, instruction) === 'unsupported')) return { accepted: false, reason: 'unsupported_compute_instruction' };
  if (!preparedInstructions.slice(0, 2).every((instruction) => computeKind(prepared, instruction)) || !returnedInstructions.slice(0, 2).every((instruction) => computeKind(returned, instruction))) return { accepted: false, reason: 'compute_prefix_changed' };
  const preparedByKind = new Map(preparedCompute.map((instruction) => [computeKind(prepared, instruction), instruction]));
  const returnedByKind = new Map(returnedCompute.map((instruction) => [computeKind(returned, instruction), instruction]));
  for (const kind of ['limit', 'price'] as const) {
    const before = preparedByKind.get(kind); const after = returnedByKind.get(kind);
    if (!before || !after || !sameInstruction(prepared, before, returned, after)) return { accepted: false, reason: 'compute_value_changed' };
  }
  const returnedKinds = returnedCompute.map((instruction) => computeKind(returned, instruction)).join('|');
  if (returnedKinds !== 'limit|price') return { accepted: false, reason: 'unsupported_compute_order' };

  const preparedEconomics = preparedInstructions.slice(2);
  const returnedTail = returnedInstructions.slice(2);
  const returnedEconomics = returnedTail.slice(0, preparedEconomics.length);
  if (returnedEconomics.length !== preparedEconomics.length || !preparedEconomics.every((instruction, index) => sameInstruction(prepared, instruction, returned, returnedEconomics[index]!))) return { accepted: false, reason: 'economic_instruction_changed' };
  const assertions = returnedTail.slice(preparedEconomics.length);
  if (!hasLighthouse && assertions.length === 0) return { accepted: true, augmented: true };
  if (!hasLighthouse) return { accepted: false, reason: 'lighthouse_program_missing' };
  if (assertions.length < 1 || assertions.length > MAX_LIGHTHOUSE_ASSERTIONS) return { accepted: false, reason: 'lighthouse_count_invalid' };
  const preparedStaticKeys = new Set(preparedKeys);
  if (!assertions.every((instruction) => lighthouseAssertionIsSupported(returned, instruction, preparedStaticKeys))) return { accepted: false, reason: 'lighthouse_assertion_invalid' };
  return { accepted: true, augmented: true };
}
