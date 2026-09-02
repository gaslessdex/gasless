import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicKey, verify } from 'node:crypto';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { RecoverAuthorizationSigner } from '../server/recover/authorization.js';
import type { TransactionQuote } from '../shared/transactions/types.js';
import { versionedMessageHash } from '../chains/solana/transactions/clean.js';

function preparedQuote(transaction: VersionedTransaction, wallet: Keypair, source: Keypair, mint: Keypair, treasury: Keypair): TransactionQuote {
  const messageHash = versionedMessageHash(transaction);
  return {
    quoteId: crypto.randomUUID(),
    intent: { intentId: crypto.randomUUID(), walletAddress: wallet.publicKey.toBase58(), actionType: 'CLEAN_RECOVER', network: 'mainnet-beta', requestId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), metadata: {} },
    status: 'awaiting_user_signature', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
    recover: {
      schemaVersion: 'recover-v1',
      account: { address: source.publicKey.toBase58(), mint: mint.publicKey.toBase58(), tokenAmountRaw: '500', decimals: 6, recoverableLamports: '2039280', stateFingerprint: 'state' },
      outputMint: 'So11111111111111111111111111111111111111112', slippageBps: 50, routeLabel: 'Raydium CLMM', routeFingerprint: 'route', wrappedSolState: { address: Keypair.generate().publicKey.toBase58(), exists: false, stateFingerprint: 'wrapped' },
      estimatedSwapOutputLamports: '1000', minimumSwapOutputLamports: '995', swapServiceFeeBps: 30, swapServiceFeeLamports: '2', rentServiceFeeBps: 300, rentServiceFeeLamports: '60', feeDestination: treasury.publicKey.toBase58(), status: 'awaiting_user_signature', route: {}, networkFeeLamports: '5000', temporaryAccountRentLamports: '2039280', sponsoredCostLamports: '2044280', minimumUserPayoutLamports: '1',
      prepared: { transactionId: crypto.randomUUID(), quoteId: 'quote', walletAddress: wallet.publicKey.toBase58(), expectedFeePayer: transaction.message.staticAccountKeys[0].toBase58(), serializedTransaction: Buffer.from(transaction.serialize()).toString('base64'), preparedMessageHash: messageHash, recentBlockhash: transaction.message.recentBlockhash, lastValidBlockHeight: 100, allowedProgramIds: [SystemProgram.programId.toBase58()], simulation: { provider: 'test', unitsConsumed: 1 }, walletSigningReadyAt: new Date().toISOString(), walletSigningExpiresAt: new Date(Date.now() + 60_000).toISOString(), walletSigningWindowMs: 60_000 },
    },
  } as unknown as TransactionQuote;
}

function transaction(payer: Keypair, wallet: Keypair, lamports: number, blockhash = Keypair.generate().publicKey.toBase58()) {
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports })] }).compileToV0Message();
  return new VersionedTransaction(message);
}

test('server signs exact Recover claims with a dedicated Ed25519 key', () => {
  const authority = Keypair.generate(); const payer = Keypair.generate(); const wallet = Keypair.generate(); const source = Keypair.generate(); const mint = Keypair.generate(); const treasury = Keypair.generate();
  const tx = transaction(payer, wallet, 1); const quote = preparedQuote(tx, wallet, source, mint, treasury);
  const signer = new RecoverAuthorizationSigner(JSON.stringify([...authority.secretKey]));
  const authorization = signer.authorize(quote, Buffer.from(tx.serialize()).toString('base64'), new Date('2026-08-30T00:00:00Z'));
  const payload = Buffer.from(authorization.payload, 'base64url');
  const claims = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), authority.publicKey.toBuffer()]), format: 'der', type: 'spki' });
  assert.equal(verify(null, payload, publicKey, bs58.decode(authorization.signature)), true);
  assert.equal(claims.message_hash, versionedMessageHash(tx));
  assert.equal(claims.action, 'CLEAN_RECOVER');
  assert.equal(claims.source_token_account, source.publicKey.toBase58());
  assert.equal(claims.expires_at_unix_seconds, Number(claims.issued_at_unix_seconds) + 60);
  assert.equal((quote.recover as unknown as Record<string, unknown>).authorization, undefined);
});

test('Recover authorization is issued only for the final wallet-returned message hash', () => {
  const authority = Keypair.generate(); const payer = Keypair.generate(); const wallet = Keypair.generate(); const source = Keypair.generate(); const mint = Keypair.generate(); const treasury = Keypair.generate();
  const original = transaction(payer, wallet, 1); const quote = preparedQuote(original, wallet, source, mint, treasury);
  const signer = new RecoverAuthorizationSigner(JSON.stringify([...authority.secretKey]));
  const mutated = transaction(payer, wallet, 2, original.message.recentBlockhash);
  const originalAuthorization = signer.authorize(quote, Buffer.from(original.serialize()).toString('base64'));
  const finalAuthorization = signer.authorize(quote, Buffer.from(mutated.serialize()).toString('base64'));
  const originalClaims = JSON.parse(Buffer.from(originalAuthorization.payload, 'base64url').toString('utf8')) as { message_hash: string };
  const finalClaims = JSON.parse(Buffer.from(finalAuthorization.payload, 'base64url').toString('utf8')) as { message_hash: string };
  assert.equal(originalClaims.message_hash, versionedMessageHash(original));
  assert.equal(finalClaims.message_hash, versionedMessageHash(mutated));
  assert.notEqual(originalClaims.message_hash, finalClaims.message_hash);
});

test('two fresh Recover messages receive independent authorizations without configuration changes', () => {
  const authority = Keypair.generate(); const payer = Keypair.generate(); const wallet = Keypair.generate(); const source = Keypair.generate(); const mint = Keypair.generate(); const treasury = Keypair.generate();
  const signer = new RecoverAuthorizationSigner(JSON.stringify([...authority.secretKey]));
  const first = transaction(payer, wallet, 1); const second = transaction(payer, wallet, 1);
  const firstAuthorization = signer.authorize(preparedQuote(first, wallet, source, mint, treasury), Buffer.from(first.serialize()).toString('base64'));
  const secondAuthorization = signer.authorize(preparedQuote(second, wallet, source, mint, treasury), Buffer.from(second.serialize()).toString('base64'));
  assert.notEqual(firstAuthorization.payload, secondAuthorization.payload);
  assert.equal(signer.publicKey, authority.publicKey.toBase58());
});
