import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { relayOrderId, type RelayProtocolOrder } from '../chains/solana/relay/order.js';
import { RELAY_DEPOSITORY_PROGRAM_ID, RELAY_MAINNET_LOOKUP_TABLE, validateRelayTransaction, assertRelaySimulation, type RelayValidationIntent, type RelayValidationQuote } from '../chains/solana/relay/validator.js';
import { deriveAssociatedTokenAddress } from '../chains/solana/send/accounts.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../chains/solana/claim/accounts.js';
import { sponsorSignValidatedRelayTransaction, validateUserSignedRelayTransaction } from '../server/cross-chain/sponsorship.js';
import { RelayAuthorizationSigner } from '../server/cross-chain/authorization.js';
import { KoraRelayerProvider, LocalDevnetRelayerProvider, type RelayerProvider } from '../server/relayer/provider.js';
import type { RpcAccountInfo } from '../server/solana/rpc.js';
import { GaslessError } from '../server/errors.js';

const ASSETS = {
  SOL: '11111111111111111111111111111111',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
} as const;
const OUTPUTS = { ETH: '0x0000000000000000000000000000000000000000', USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' } as const;
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const ACTIVE = (1n << 64n) - 1n;

function tokenAccount(mint: string, owner: string, amount = 20_000_000n): RpcAccountInfo {
  const data = Buffer.alloc(165); new PublicKey(mint).toBuffer().copy(data, 0); new PublicKey(owner).toBuffer().copy(data, 32); data.writeBigUInt64LE(amount, 64); data[108] = 1;
  return { lamports: 2_039_280, owner: LEGACY_TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0, data: [data.toString('base64'), 'base64'] };
}

function fixture(inputAsset: keyof typeof ASSETS = 'SOL', destinationAsset: keyof typeof OUTPUTS = 'ETH') {
  const wallet = Keypair.generate(); const payer = Keypair.generate(); const amount = '10000000'; const inputMint = ASSETS[inputAsset]; const destinationMint = OUTPUTS[destinationAsset];
  const program = new PublicKey(RELAY_DEPOSITORY_PROGRAM_ID);
  const depository = PublicKey.findProgramAddressSync([Buffer.from('relay_depository')], program)[0].toBase58();
  const vault = PublicKey.findProgramAddressSync([Buffer.from('vault')], program)[0].toBase58();
  const order: RelayProtocolOrder = {
    version: 'v1', solverChainId: 'base', solver: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', salt: '0x01',
    inputs: [{ payment: { chainId: 'solana', currency: inputMint, amount, weight: '1' }, refunds: [
      { chainId: 'solana', recipient: wallet.publicKey.toBase58(), currency: inputMint, minimumAmount: '0', deadline: 2_000_000_000, extraData: '0x' },
      { chainId: 'robinhood', recipient: RECIPIENT, currency: destinationMint, minimumAmount: '0', deadline: 2_000_000_000, extraData: '0x' },
    ] }],
    output: { chainId: 'robinhood', payments: [{ recipient: RECIPIENT, currency: destinationMint, minimumAmount: '900000', expectedAmount: '1000000' }], calls: [], deadline: 2_000_000_000, extraData: '0x000000000000000000000000b92fe925dc43a0ecde6c8b1a2709c170ec4fff4f' }, fees: [],
  };
  order.inputs[0].refunds[1].extraData = order.output.extraData;
  const orderId = relayOrderId(order);
  const discriminator = inputAsset === 'SOL' ? Buffer.from([13, 158, 13, 223, 95, 213, 28, 6]) : Buffer.from([11, 156, 96, 218, 39, 163, 180, 19]);
  const amountData = Buffer.alloc(8); amountData.writeBigUInt64LE(BigInt(amount));
  const keys = inputAsset === 'SOL' ? [
    { pubkey: depository, isSigner: false, isWritable: false }, { pubkey: wallet.publicKey.toBase58(), isSigner: true, isWritable: true }, { pubkey: wallet.publicKey.toBase58(), isSigner: false, isWritable: false }, { pubkey: vault, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
  ] : (() => {
    const source = deriveAssociatedTokenAddress(wallet.publicKey.toBase58(), inputMint);
    const vaultToken = deriveAssociatedTokenAddress(vault, inputMint);
    return [
      { pubkey: depository, isSigner: false, isWritable: false }, { pubkey: wallet.publicKey.toBase58(), isSigner: true, isWritable: true }, { pubkey: wallet.publicKey.toBase58(), isSigner: false, isWritable: false }, { pubkey: vault, isSigner: false, isWritable: false }, { pubkey: inputMint, isSigner: false, isWritable: false }, { pubkey: source, isSigner: false, isWritable: true }, { pubkey: vaultToken, isSigner: false, isWritable: true }, { pubkey: LEGACY_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ];
  })();
  const instruction = { programId: RELAY_DEPOSITORY_PROGRAM_ID, keys, data: Buffer.concat([discriminator, amountData, Buffer.from(orderId.slice(2), 'hex')]).toString('hex') };
  const requestId = `0x${'12'.repeat(32)}`;
  const quote: RelayValidationQuote = { requestId, details: { sender: wallet.publicKey.toBase58(), recipient: RECIPIENT, currencyIn: { amount, currency: { chainId: 792703809, address: inputMint } }, currencyOut: { amount: '1000000', minimumAmount: '900000', currency: { chainId: 4663, address: destinationMint } } }, protocol: { v2: { orderId, orderData: order, paymentDetails: { chainId: 'solana', depository: RELAY_DEPOSITORY_PROGRAM_ID, currency: inputMint, amount } } }, steps: [{ kind: 'transaction', requestId, items: [{ data: { instructions: [instruction], addressLookupTableAddresses: [RELAY_MAINNET_LOOKUP_TABLE] } }] }] };
  const intent: RelayValidationIntent = { wallet: wallet.publicKey.toBase58(), quoteId: 'quote', relayRequestId: requestId, inputAsset, inputMint, inputAmountRaw: amount, destinationAsset, destinationMint, recipient: RECIPIENT, depositFeePayer: payer.publicKey.toBase58(), expiresAt: new Date(Date.now() + 60_000).toISOString(), maximumSponsoredCostLamports: 20_000 };
  const table = new AddressLookupTableAccount({ key: new PublicKey(RELAY_MAINNET_LOOKUP_TABLE), state: { deactivationSlot: ACTIVE, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: Keypair.generate().publicKey, addresses: keys.map((key) => new PublicKey(key.pubkey)) } });
  const account = inputAsset === 'SOL' ? null : tokenAccount(inputMint, intent.wallet);
  const rpc = { fee: 10_000, table: table as AddressLookupTableAccount | null, account, async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 123 }; }, async getFeeForMessage() { return this.fee; }, async getAccountInfo() { return this.account; }, async getAddressLookupTable() { return this.table; } };
  return { wallet, payer, quote, intent, rpc, order, instruction };
}

async function rejectsCode(action: () => Promise<unknown>, code = 'RELAYER_POLICY_REJECTED') { await assert.rejects(action, (error: unknown) => error instanceof GaslessError && error.code === code); }

test('Relay order hashing binds all six representative input/output classes', async () => {
  for (const input of Object.keys(ASSETS) as Array<keyof typeof ASSETS>) for (const output of Object.keys(OUTPUTS) as Array<keyof typeof OUTPUTS>) {
    const value = fixture(input, output); const validated = await validateRelayTransaction(value.quote, value.intent, value.rpc);
    assert.equal(validated.inputAsset, input); assert.equal(validated.destinationAsset, output); assert.equal(validated.orderId, value.quote.protocol!.v2!.orderId); assert.equal(VersionedTransaction.deserialize(Buffer.from(validated.serializedTransaction, 'base64')).message.header.numRequiredSignatures, 2);
  }
});

test('Relay validation rejects missing, deactivated, substituted, and unresolved lookup tables', async () => {
  const missing = fixture(); missing.rpc.table = null; await rejectsCode(() => validateRelayTransaction(missing.quote, missing.intent, missing.rpc));
  const inactive = fixture(); inactive.rpc.table = new AddressLookupTableAccount({ key: new PublicKey(RELAY_MAINNET_LOOKUP_TABLE), state: { ...inactive.rpc.table!.state, deactivationSlot: 1n } }); await rejectsCode(() => validateRelayTransaction(inactive.quote, inactive.intent, inactive.rpc));
  const substituted = fixture(); substituted.quote.steps![0].items![0].data!.addressLookupTableAddresses = [Keypair.generate().publicKey.toBase58()]; await rejectsCode(() => validateRelayTransaction(substituted.quote, substituted.intent, substituted.rpc));
});

test('Relay validation rejects wrong payer, user, mint, amount, recipient, and opaque order mutation', async () => {
  const payer = fixture(); payer.intent.depositFeePayer = payer.intent.wallet; await rejectsCode(() => validateRelayTransaction(payer.quote, payer.intent, payer.rpc));
  const user = fixture(); user.quote.details!.sender = Keypair.generate().publicKey.toBase58(); await rejectsCode(() => validateRelayTransaction(user.quote, user.intent, user.rpc));
  const mint = fixture('USDC'); mint.intent.inputMint = ASSETS.USDT; await rejectsCode(() => validateRelayTransaction(mint.quote, mint.intent, mint.rpc));
  const amount = fixture(); amount.intent.inputAmountRaw = '10000001'; await rejectsCode(() => validateRelayTransaction(amount.quote, amount.intent, amount.rpc));
  const recipient = fixture(); recipient.intent.recipient = '0x2222222222222222222222222222222222222222'; await rejectsCode(() => validateRelayTransaction(recipient.quote, recipient.intent, recipient.rpc));
  const order = fixture(); order.order.output.payments[0].recipient = '0x2222222222222222222222222222222222222222'; await rejectsCode(() => validateRelayTransaction(order.quote, order.intent, order.rpc));
});

test('Relay validation rejects unknown or extra instructions and transfer-shaped substitutions', async () => {
  const unknown = fixture(); unknown.instruction.programId = Keypair.generate().publicKey.toBase58(); await rejectsCode(() => validateRelayTransaction(unknown.quote, unknown.intent, unknown.rpc));
  const extra = fixture(); extra.quote.steps![0].items![0].data!.instructions.push({ programId: SystemProgram.programId.toBase58(), keys: [], data: '00' }); await rejectsCode(() => validateRelayTransaction(extra.quote, extra.intent, extra.rpc));
  const transfer = fixture(); transfer.instruction.programId = SystemProgram.programId.toBase58(); transfer.instruction.data = '020000000100000000000000'; await rejectsCode(() => validateRelayTransaction(transfer.quote, transfer.intent, transfer.rpc));
});

test('Relay token source must be the canonical ordinary user ATA with enough exact asset balance', async () => {
  const wrongOwner = fixture('USDC'); wrongOwner.rpc.account = tokenAccount(ASSETS.USDC, Keypair.generate().publicKey.toBase58()); await rejectsCode(() => validateRelayTransaction(wrongOwner.quote, wrongOwner.intent, wrongOwner.rpc));
  const insufficient = fixture('USDT'); insufficient.rpc.account = tokenAccount(ASSETS.USDT, insufficient.intent.wallet, 1n); await rejectsCode(() => validateRelayTransaction(insufficient.quote, insufficient.intent, insufficient.rpc));
});

test('Relay sponsor exposure is fee-only, explicit, and capped', async () => {
  const normal = fixture(); const validated = await validateRelayTransaction(normal.quote, normal.intent, normal.rpc); assert.equal(validated.expectedSponsorMaxLamports, 10_000);
  const excessive = fixture(); excessive.rpc.fee = 20_001; await rejectsCode(() => validateRelayTransaction(excessive.quote, excessive.intent, excessive.rpc));
});

test('Relay simulation requires success logs and rejects unknown CPI programs', () => {
  const value = fixture(); const validated = { inputAsset: 'SOL', inputMint: ASSETS.SOL, inputAmountRaw: '10000000', expectedSourceAccount: value.intent.wallet, expectedVaultAccount: value.instruction.keys[3].pubkey } as Awaited<ReturnType<typeof validateRelayTransaction>>;
  const success = { err: null, logs: [`Program ${RELAY_DEPOSITORY_PROGRAM_ID} success`], innerInstructions: [{ instructions: [{ programId: SystemProgram.programId.toBase58(), parsed: { type: 'transfer', info: { source: validated.expectedSourceAccount, destination: validated.expectedVaultAccount, lamports: 10_000_000 } } }] }] };
  assert.doesNotThrow(() => assertRelaySimulation(success, validated));
  assert.throws(() => assertRelaySimulation({ ...success, innerInstructions: [{ instructions: [{ programId: Keypair.generate().publicKey.toBase58() }] }] }, validated));
  assert.throws(() => assertRelaySimulation({ err: { custom: 1 }, logs: [] }, validated));
  const token = fixture('USDC'); const tokenValidated = { inputAsset: 'USDC', inputMint: ASSETS.USDC, inputAmountRaw: '10000000', wallet: token.intent.wallet, expectedSourceAccount: token.instruction.keys[5].pubkey, expectedVaultAccount: token.instruction.keys[6].pubkey } as Awaited<ReturnType<typeof validateRelayTransaction>>;
  assert.doesNotThrow(() => assertRelaySimulation({ err: null, logs: [`Program ${RELAY_DEPOSITORY_PROGRAM_ID} success`], innerInstructions: [{ instructions: [{ programId: LEGACY_TOKEN_PROGRAM_ID, parsed: { type: 'transferChecked', info: { source: tokenValidated.expectedSourceAccount, destination: tokenValidated.expectedVaultAccount, authority: tokenValidated.wallet, mint: ASSETS.USDC, tokenAmount: { amount: '10000000' } } } }] }] }, tokenValidated));
});

test('sponsor-first and user-second signing preserve the exact message and signer slots', async () => {
  const value = fixture(); const validated = await validateRelayTransaction(value.quote, value.intent, value.rpc); const relayer = new LocalDevnetRelayerProvider(JSON.stringify([...value.payer.secretKey]));
  const sponsorSigned = await sponsorSignValidatedRelayTransaction(validated, relayer);
  const userTransaction = VersionedTransaction.deserialize(Buffer.from(sponsorSigned, 'base64')); userTransaction.sign([value.wallet]); const fullySigned = Buffer.from(userTransaction.serialize()).toString('base64');
  assert.equal(validateUserSignedRelayTransaction(sponsorSigned, fullySigned, validated), fullySigned);
  const mutation = fixture(); const other = await validateRelayTransaction(mutation.quote, mutation.intent, mutation.rpc); await rejectsCode(async () => validateUserSignedRelayTransaction(sponsorSigned, other.serializedTransaction, validated), 'MESSAGE_MISMATCH');
});

test('sponsor signer mutation and unsupported legacy output fail closed', async () => {
  const value = fixture(); const validated = await validateRelayTransaction(value.quote, value.intent, value.rpc);
  const mutating: RelayerProvider = { async getFeePayerPublicKey() { return value.intent.depositFeePayer; }, async signTransaction() { const changed = VersionedTransaction.deserialize(Buffer.from(validated.serializedTransaction, 'base64')); changed.message.recentBlockhash = Keypair.generate().publicKey.toBase58(); changed.sign([value.payer]); return Buffer.from(changed.serialize()).toString('base64'); } };
  await rejectsCode(() => sponsorSignValidatedRelayTransaction(validated, mutating), 'MESSAGE_MISMATCH');
  const legacy: RelayerProvider = { async getFeePayerPublicKey() { return value.intent.depositFeePayer; }, async signTransaction() { const transaction = new Transaction({ feePayer: value.payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }); transaction.partialSign(value.payer); return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'); } };
  await rejectsCode(() => sponsorSignValidatedRelayTransaction(validated, legacy), 'MESSAGE_MISMATCH');
});

test('Kora signTransaction-compatible response preserves the v0 message and user signer slot', async () => {
  const value = fixture(); const validated = await validateRelayTransaction(value.quote, value.intent, value.rpc); const authority = Keypair.generate(); const authorizationSigner = new RelayAuthorizationSigner(JSON.stringify([...authority.secretKey]));
  const request = async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body)) as { id: string; method: string; params: { transaction: string; relay_authorization?: { payload: string; signature: string } } };
    if (payload.method === 'getPayerSigner') return Response.json({ jsonrpc: '2.0', id: payload.id, result: { signer_address: value.payer.publicKey.toBase58() } });
    assert.equal(payload.method, 'signTransaction');
    assert(payload.params.relay_authorization?.signature);
    const claims = JSON.parse(Buffer.from(payload.params.relay_authorization.payload, 'base64url').toString('utf8'));
    assert.equal(claims.message_hash, validated.messageHash); assert.equal(claims.fee_payer, validated.depositFeePayer); assert.equal(claims.wallet, validated.wallet); assert.equal(claims.relay_order_id, validated.orderId); assert.equal(claims.max_sponsor_lamports, validated.expectedSponsorMaxLamports);
    const transaction = VersionedTransaction.deserialize(Buffer.from(payload.params.transaction, 'base64'));
    transaction.sign([value.payer]);
    return Response.json({ jsonrpc: '2.0', id: payload.id, result: { signer_pubkey: value.payer.publicKey.toBase58(), signed_transaction: Buffer.from(transaction.serialize()).toString('base64') } });
  };
  const kora = new KoraRelayerProvider('https://kora.invalid', 'test-only', request as typeof fetch);
  const signed = await sponsorSignValidatedRelayTransaction(validated, kora, authorizationSigner);
  const transaction = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'));
  assert.equal(transaction.message.staticAccountKeys[0].toBase58(), value.intent.depositFeePayer);
  assert(transaction.signatures[1].every((byte) => byte === 0));
});

test('all six Relay route classes authorize payer-only signing and user-second signing on identical bytes', async () => {
  const authority = Keypair.generate(); const authorizationSigner = new RelayAuthorizationSigner(JSON.stringify([...authority.secretKey])); let signedRoutes = 0;
  for (const input of Object.keys(ASSETS) as Array<keyof typeof ASSETS>) for (const output of Object.keys(OUTPUTS) as Array<keyof typeof OUTPUTS>) {
    const value = fixture(input, output); const validated = await validateRelayTransaction(value.quote, value.intent, value.rpc);
    const relayer: RelayerProvider = {
      async getFeePayerPublicKey() { return value.payer.publicKey.toBase58(); },
      async signTransaction(serialized, options) {
        assert(options?.relayAuthorization?.signature);
        const claims = JSON.parse(Buffer.from(options.relayAuthorization.payload, 'base64url').toString('utf8'));
        assert.equal(claims.input_asset, input); assert.equal(claims.input_mint, ASSETS[input]); assert.equal(claims.destination_asset, output); assert.equal(claims.message_hash, validated.messageHash);
        const transaction = VersionedTransaction.deserialize(Buffer.from(serialized, 'base64')); transaction.sign([value.payer]); return Buffer.from(transaction.serialize()).toString('base64');
      },
    };
    const sponsorSigned = await sponsorSignValidatedRelayTransaction(validated, relayer, authorizationSigner); const fullySigned = VersionedTransaction.deserialize(Buffer.from(sponsorSigned, 'base64')); fullySigned.sign([value.wallet]);
    validateUserSignedRelayTransaction(sponsorSigned, Buffer.from(fullySigned.serialize()).toString('base64'), validated); signedRoutes += 1;
  }
  assert.equal(signedRoutes, 6);
});
