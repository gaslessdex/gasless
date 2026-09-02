import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { PHANTOM_LIGHTHOUSE_PROGRAM_ID, validatePhantomCompatibleTransaction } from '../chains/solana/transactions/phantom.js';

const blockhash = Keypair.generate().publicKey.toBase58();
const payer = Keypair.generate().publicKey;
const wallet = Keypair.generate().publicKey;
const memoProgram = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const lighthouseProgram = new PublicKey(PHANTOM_LIGHTHOUSE_PROGRAM_ID);
const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 375_000n });
const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 });
const memo = new TransactionInstruction({ programId: memoProgram, keys: [], data: Buffer.from('GASLESS Phantom compatibility proof') });

function transaction(instructions: TransactionInstruction[]) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message());
}

function assertion(discriminator = 5, target = payer) {
  return new TransactionInstruction({ programId: lighthouseProgram, keys: [{ pubkey: target, isSigner: false, isWritable: false }], data: Buffer.from([discriminator, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) });
}

test('accepts byte-exact wallet output without requiring Phantom augmentation', () => {
  const prepared = transaction([price, limit, memo]);
  assert.deepEqual(validatePhantomCompatibleTransaction(prepared, VersionedTransaction.deserialize(prepared.serialize())), { accepted: true, augmented: false });
});

test('accepts only the observed compute normalization and appended Lighthouse assertion', () => {
  const prepared = transaction([price, limit, memo]);
  const returned = transaction([limit, price, memo, assertion()]);
  assert.deepEqual(validatePhantomCompatibleTransaction(prepared, returned), { accepted: true, augmented: true });
});

test('rejects Lighthouse memory instructions, malformed assertions, and lookalike programs', () => {
  const prepared = transaction([price, limit, memo]);
  assert.equal(validatePhantomCompatibleTransaction(prepared, transaction([limit, price, memo, assertion(0)])).accepted, false);
  const malformed = new TransactionInstruction({ programId: lighthouseProgram, keys: [{ pubkey: payer, isSigner: false, isWritable: false }], data: Buffer.from([5, 0]) });
  assert.equal(validatePhantomCompatibleTransaction(prepared, transaction([limit, price, memo, malformed])).accepted, false);
  const lookalike = new TransactionInstruction({ ...assertion(), programId: Keypair.generate().publicKey });
  assert.equal(validatePhantomCompatibleTransaction(prepared, transaction([limit, price, memo, lookalike])).accepted, false);
});

test('rejects economic, compute, account, and instruction-order mutations', () => {
  const prepared = transaction([price, limit, memo]);
  const changedMemo = new TransactionInstruction({ programId: memoProgram, keys: [], data: Buffer.from('changed') });
  assert.equal(validatePhantomCompatibleTransaction(prepared, transaction([limit, price, changedMemo, assertion()])).accepted, false);
  assert.equal(validatePhantomCompatibleTransaction(prepared, transaction([ComputeBudgetProgram.setComputeUnitLimit({ units: 100_001 }), price, memo, assertion()])).accepted, false);
  assert.equal(validatePhantomCompatibleTransaction(prepared, transaction([limit, price, memo, SystemProgram.transfer({ fromPubkey: payer, toPubkey: wallet, lamports: 1 }), assertion()])).accepted, false);
  assert.equal(validatePhantomCompatibleTransaction(prepared, transaction([limit, price, assertion(), memo])).accepted, false);
  assert.equal(validatePhantomCompatibleTransaction(prepared, transaction([limit, price, memo, assertion(5, Keypair.generate().publicKey)])).accepted, false);
});
