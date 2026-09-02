import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { LEGACY_TOKEN_PROGRAM_ID } from '../chains/solana/claim/accounts.js';
import { deriveAssociatedTokenAddress } from '../chains/solana/send/accounts.js';
import { EmergencyControlService } from '../server/controls/service.js';
import { GaslessError } from '../server/errors.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, JUPITER_SWAP_PROGRAM_ID, RAYDIUM_CLMM_DEX, RAYDIUM_CLMM_PROGRAM_ID, SYSTEM_PROGRAM_ID, JupiterService, type JupiterBuild, type JupiterRequest, type JupiterRouter } from '../server/jupiter/service.js';
import { LocalDevnetRelayerProvider } from '../server/relayer/provider.js';
import type { RpcAccountInfo, SolanaRpc } from '../server/solana/rpc.js';
import { MemoryDurableStore } from '../server/storage/durable.js';
import { MemoryTemporaryStore } from '../server/storage/temporary.js';
import { SwapEngine } from '../server/swap/engine.js';
import { ServerTokenRegistry, type TokenRegistryEntry } from '../server/token-registry/service.js';

function tokenAccount(owner: string, mint: string, amount: bigint, state = 1): RpcAccountInfo { const data = Buffer.alloc(165); new PublicKey(mint).toBuffer().copy(data, 0); new PublicKey(owner).toBuffer().copy(data, 32); data.writeBigUInt64LE(amount, 64); data[108] = state; return { lamports: 2_039_280, owner: LEGACY_TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0, data: [data.toString('base64'), 'base64'] }; }
function entry(mint: string, input: boolean, output: boolean): TokenRegistryEntry { return { mint, symbol: input ? 'IN' : 'OUT', decimals: 6, tokenProgram: LEGACY_TOKEN_PROGRAM_ID, extensions: [], status: 'supported', enabledActions: ['SWAP'], feePaymentEnabled: input, swapInputEnabled: input, swapOutputEnabled: output || input, usdPriceMicros: input ? '1000000' : undefined, solUsdPriceMicros: input ? '200000000' : undefined, priceUpdatedAt: input ? new Date().toISOString() : undefined }; }
class Rpc { accounts = new Map<string, RpcAccountInfo>(); simulations = 0; fees: number[] = []; nativeBalance = 0; blockHeight = 10; latestLastValidBlockHeight = 160; disappearAfterFirstRead?: string; private reads = new Map<string, number>(); async getAccountInfo(address: string) { const reads = (this.reads.get(address) ?? 0) + 1; this.reads.set(address, reads); if (address === this.disappearAfterFirstRead && reads > 1) return null; return this.accounts.get(address) ?? null; } async getMinimumBalanceForRentExemption() { return 2_039_280; } async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: this.latestLastValidBlockHeight, provider: 'fake' }; } async getBlockHeight() { return this.blockHeight; } async getFeeForMessage() { return this.fees.shift() ?? 5_000; } async simulateTransaction(serialized: string) { this.simulations += 1; const transaction = VersionedTransaction.deserialize(Buffer.from(serialized, 'base64')); const programs = transaction.message.compiledInstructions.map((instruction) => transaction.message.staticAccountKeys[instruction.programIdIndex]?.toBase58()); const groups = [{ index: programs.indexOf(JUPITER_SWAP_PROGRAM_ID), instructions: [{ programId: RAYDIUM_CLMM_PROGRAM_ID, stackHeight: 2 }, { programId: LEGACY_TOKEN_PROGRAM_ID, stackHeight: 3 }] }]; const ata = programs.indexOf(ASSOCIATED_TOKEN_PROGRAM_ID); if (ata >= 0) groups.push({ index: ata, instructions: [{ programId: SYSTEM_PROGRAM_ID, stackHeight: 2 }, { programId: LEGACY_TOKEN_PROGRAM_ID, stackHeight: 2 }] }); return { err: null, logs: ['ok'], unitsConsumed: 200_000, innerInstructions: groups, provider: 'fake' }; } async getBalance() { return this.nativeBalance; } }
class Jupiter implements JupiterRouter {
  builds = 0;
  setupCopies = 1;
  lastRequest?: JupiterRequest;
  async quote(): Promise<never> { throw new Error('Swap tests do not use quote-only routing.'); }
  async build(input: JupiterRequest) { this.builds += 1; this.lastRequest = input; const outputMint = input.outputMint!; const source = deriveAssociatedTokenAddress(input.taker, input.inputMint); const output = deriveAssociatedTokenAddress(input.taker, outputMint); const setupInstruction = { programId: ASSOCIATED_TOKEN_PROGRAM_ID, accounts: [{ pubkey: input.payer, isSigner: true, isWritable: true }, { pubkey: output, isSigner: false, isWritable: true }, { pubkey: input.taker, isSigner: false, isWritable: false }, { pubkey: outputMint, isSigner: false, isWritable: false }, { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: LEGACY_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }], data: Buffer.from([1]).toString('base64') }; const setupInstructions = Array.from({ length: this.setupCopies }, () => structuredClone(setupInstruction)); return { inputMint: input.inputMint, outputMint, inAmount: input.amount, outAmount: '50000000', otherAmountThreshold: '49750000', swapMode: 'ExactIn', slippageBps: input.slippageBps, priceImpactPct: '0.0025', routePlan: [{ swapInfo: { label: RAYDIUM_CLMM_DEX, inputMint: input.inputMint, outputMint, inAmount: input.amount, outAmount: '50000000' }, bps: 10_000 }], computeBudgetInstructions: [{ programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]).toString('base64') }], setupInstructions, swapInstruction: { programId: JUPITER_SWAP_PROGRAM_ID, accounts: [{ pubkey: input.taker, isSigner: true, isWritable: false }, { pubkey: input.payer, isSigner: true, isWritable: true }, { pubkey: source, isSigner: false, isWritable: true }, { pubkey: output, isSigner: false, isWritable: true }, { pubkey: RAYDIUM_CLMM_PROGRAM_ID, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]).toString('base64') }, cleanupInstruction: null, otherInstructions: [], tipInstruction: null, addressesByLookupTableAddress: {}, blockhashWithMetadata: { blockhash: [...Keypair.generate().publicKey.toBytes()], lastValidBlockHeight: 100 } } satisfies JupiterBuild; }
  validate(build: JupiterBuild, expected: Parameters<JupiterRouter['validate']>[1], height: number) { new JupiterService('unused', 'test').validate(build, expected, height); }
}
function fixture(outputExists: boolean, now: () => number = Date.now, risk?: { releaseQuoteExposure(quote: unknown): Promise<'released' | 'already_released'> }) { const wallet = Keypair.generate(); const relayer = Keypair.generate(); const inputMint = Keypair.generate().publicKey.toBase58(); const outputMint = Keypair.generate().publicKey.toBase58(); const reimbursement = Keypair.generate().publicKey.toBase58(); const service = Keypair.generate().publicKey.toBase58(); const rpc = new Rpc(); rpc.accounts.set(deriveAssociatedTokenAddress(wallet.publicKey.toBase58(), inputMint), tokenAccount(wallet.publicKey.toBase58(), inputMint, 100_000_000n)); if (outputExists) rpc.accounts.set(deriveAssociatedTokenAddress(wallet.publicKey.toBase58(), outputMint), tokenAccount(wallet.publicKey.toBase58(), outputMint, 0n)); rpc.accounts.set(deriveAssociatedTokenAddress(reimbursement, inputMint), tokenAccount(reimbursement, inputMint, 0n)); rpc.accounts.set(deriveAssociatedTokenAddress(service, inputMint), tokenAccount(service, inputMint, 0n)); const temporary = new MemoryTemporaryStore(now); const durable = new MemoryDurableStore(); const jupiter = new Jupiter(); const engine = new SwapEngine(temporary, durable, rpc as unknown as SolanaRpc, new LocalDevnetRelayerProvider(JSON.stringify([...relayer.secretKey])), new EmergencyControlService(durable), new ServerTokenRegistry([], [], [entry(inputMint, true, false), entry(outputMint, false, true)]), jupiter, 120, { reimbursementWallet: reimbursement, serviceFeeWallet: service, serviceFeeBps: 30, defaultSlippageBps: 50, maximumSlippageBps: 100, maximumPriceImpactBps: 100, priceMaxAgeSeconds: 300, maximumSponsoredCostLamports: 3_000_000, relayerLowBalanceThresholdLamports: 100_000 }, undefined, risk); return { wallet, relayer, inputMint, outputMint, reimbursement, service, rpc, temporary, durable, jupiter, engine }; }
async function expectCode(action: () => Promise<unknown>, code: string) { await assert.rejects(action, (error: unknown) => error instanceof GaslessError && error.code === code); }

test('SWAP discovery and read-only quote work with Mainnet disabled while preparation remains blocked', async () => {
  const f = fixture(false);
  const discovery = await f.engine.discover(f.wallet.publicKey.toBase58(), 'mainnet-beta');
  assert.deepEqual(discovery.inputTokens.map((token) => token.mint), [f.inputMint]);
  assert.equal(discovery.inputTokens[0]?.balanceRaw, '100000000');
  assert.equal(discovery.outputTokens.find((token) => token.mint === f.outputMint)?.outputAtaExists, false);
  assert.equal(discovery.outputTokens.find((token) => token.mint === f.outputMint)?.balanceRaw, undefined);
  assert.equal(f.rpc.accounts.has(deriveAssociatedTokenAddress(f.wallet.publicKey.toBase58(), f.outputMint)), false);
  const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'mainnet-beta', inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: 'disabled-mainnet', requestId: 'disabled-mainnet' });
  assert.equal(quote.swap?.outputAtaExists, false);
  assert.equal(f.rpc.nativeBalance, 0);
  assert.equal((await f.temporary.getQuote(quote.quoteId))?.quoteId, quote.quoteId);
  await expectCode(() => f.engine.prepare(quote.quoteId, f.wallet.publicKey.toBase58(), 'disabled-prepare'), 'ACTION_DISABLED');
  assert.equal((await f.temporary.getQuote(quote.quoteId))?.quoteId, quote.quoteId);
});

for (const outputExists of [true, false]) test(`SWAP quote and prepare bind exact economics with output ATA ${outputExists ? 'present' : 'missing'}`, async () => {
  const f = fixture(outputExists); const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', inputMint: f.inputMint, outputMint: f.outputMint, amount: '100', clientRequestId: 'quote', requestId: 'quote' }); const swap = quote.swap!;
  assert.equal(swap.totalInputRaw, '100000000'); assert.equal(swap.serviceFeeRaw, '300000'); assert.equal(BigInt(swap.routedInputRaw) + BigInt(swap.serviceFeeRaw) + BigInt(swap.sponsorReimbursementRaw), 100_000_000n);
  assert.equal(swap.outputAtaExists, outputExists); assert.equal(swap.outputAtaRentLamports, outputExists ? '0' : '2039280'); assert.equal(swap.sponsoredCostLamports, outputExists ? '5000' : '2044280');
  assert.equal((swap.route as JupiterBuild).setupInstructions.length, outputExists ? 0 : 1); assert.equal(f.jupiter.lastRequest?.destinationTokenAccount, swap.outputAccount);
  assert.equal(quote.intent.walletAddress, f.wallet.publicKey.toBase58()); assert.equal(quote.intent.network, 'devnet'); assert.deepEqual(quote.intent.metadata, { schemaVersion: 'swap-v1', inputMint: f.inputMint, outputMint: f.outputMint }); assert.equal((await f.temporary.getQuote(quote.quoteId))?.swap?.totalInputRaw, '100000000');
  const prepared = await f.engine.prepare(quote.quoteId, f.wallet.publicKey.toBase58(), 'prepare'); const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.swap!.prepared!.serializedTransaction, 'base64')); const outerPrograms = transaction.message.compiledInstructions.map((instruction) => transaction.message.staticAccountKeys[instruction.programIdIndex]?.toBase58());
  assert.equal(prepared.swap!.prepared!.expectedFeePayer, f.relayer.publicKey.toBase58()); assert.equal(outerPrograms.includes(ASSOCIATED_TOKEN_PROGRAM_ID), !outputExists); assert.equal(f.rpc.simulations, 1); assert.equal((await f.temporary.getQuote(quote.quoteId))?.status, 'awaiting_user_signature'); assert.equal(await f.temporary.hasReplayLock(`swap-submission:${quote.quoteId}`), false);
  assert.ok(Date.parse(prepared.swap!.prepared!.walletSigningExpiresAt!) > Date.now()); assert.equal(prepared.swap!.prepared!.lastValidBlockHeight, 160);
});

test('SWAP discovery refreshes both actionable input balances and output holdings', async () => {
  const f = fixture(true); const wallet = f.wallet.publicKey.toBase58(); const inputAta = deriveAssociatedTokenAddress(wallet, f.inputMint); const outputAta = deriveAssociatedTokenAddress(wallet, f.outputMint);
  f.rpc.accounts.set(outputAta, tokenAccount(wallet, f.outputMint, 42_000_000n));
  const before = await f.engine.discover(wallet, 'devnet');
  assert.equal(before.inputTokens.find((token) => token.mint === f.inputMint)?.balanceRaw, '100000000');
  assert.equal(before.outputTokens.find((token) => token.mint === f.outputMint)?.balanceRaw, '42000000');
  assert.equal(before.outputTokens.find((token) => token.mint === f.outputMint)?.outputAtaExists, true);
  assert.equal(before.inputTokens.some((token) => token.mint === f.outputMint), false);
  f.rpc.accounts.set(inputAta, tokenAccount(wallet, f.inputMint, 99_000_000n)); f.rpc.accounts.set(outputAta, tokenAccount(wallet, f.outputMint, 43_000_000n));
  const after = await f.engine.discover(wallet, 'devnet');
  assert.equal(after.inputTokens.find((token) => token.mint === f.inputMint)?.balanceRaw, '99000000');
  assert.equal(after.outputTokens.find((token) => token.mint === f.outputMint)?.balanceRaw, '43000000');
});

test('pre-sign preparation rejects a quote without the required signing margin before simulation', async () => {
  const f = fixture(true); const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: 'near-expiry', requestId: 'near-expiry' }); const stored = await f.temporary.getQuote(quote.quoteId); stored!.expiresAt = new Date(Date.now() + 44_000).toISOString(); await f.temporary.saveQuote(stored!, 44);
  await expectCode(() => f.engine.prepare(quote.quoteId, f.wallet.publicKey.toBase58(), 'near-expiry-prepare'), 'QUOTE_EXPIRED'); assert.equal(f.rpc.simulations, 0); assert.equal(f.durable.transactions.size, 0);
});

test('pre-sign preparation rejects a fresh blockhash without the required submission margin', async () => {
  const f = fixture(true); f.rpc.latestLastValidBlockHeight = 109; const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: 'short-blockhash', requestId: 'short-blockhash' });
  await expectCode(() => f.engine.prepare(quote.quoteId, f.wallet.publicKey.toBase58(), 'short-blockhash-prepare'), 'QUOTE_EXPIRED'); assert.equal(f.rpc.simulations, 1); assert.equal(f.durable.transactions.size, 0);
});

test('only the newest server-authoritative quote generation can reach preparation', async () => {
  const f = fixture(true); const input = { walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet' as const, inputMint: f.inputMint, outputMint: f.outputMint, amount: '1' };
  const older = await f.engine.createQuote({ ...input, clientRequestId: 'authority-old', requestId: 'authority-old', authorityVersion: 1 });
  const newer = await f.engine.createQuote({ ...input, clientRequestId: 'authority-new', requestId: 'authority-new', authorityVersion: 2 });
  await expectCode(() => f.engine.prepare(older.quoteId, f.wallet.publicKey.toBase58(), 'authority-old-prepare'), 'QUOTE_EXPIRED'); await f.engine.prepare(newer.quoteId, f.wallet.publicKey.toBase58(), 'authority-new-prepare');
  await expectCode(() => f.engine.createQuote({ ...input, clientRequestId: 'authority-late-old', requestId: 'authority-late-old', authorityVersion: 1 }), 'QUOTE_EXPIRED'); assert.equal(await f.temporary.isAuthoritativeSwapQuote(`devnet:${f.wallet.publicKey.toBase58()}`, newer.quoteId), true);
});

test('existing ATA strips one canonical redundant setup but rejects duplicates', async () => {
  const accepted = fixture(true); const quote = await accepted.engine.createQuote({ walletAddress: accepted.wallet.publicKey.toBase58(), network: 'devnet', inputMint: accepted.inputMint, outputMint: accepted.outputMint, amount: '1', clientRequestId: 'redundant', requestId: 'redundant' });
  assert.equal((quote.swap?.route as JupiterBuild).setupInstructions.length, 0); assert.equal(quote.swap?.outputAtaRentLamports, '0');
  const duplicate = fixture(true); duplicate.jupiter.setupCopies = 2;
  await expectCode(() => duplicate.engine.createQuote({ walletAddress: duplicate.wallet.publicKey.toBase58(), network: 'devnet', inputMint: duplicate.inputMint, outputMint: duplicate.outputMint, amount: '1', clientRequestId: 'duplicate', requestId: 'duplicate' }), 'JUPITER_ROUTE_REJECTED');
});

test('existing ATA validation fails closed for wrong state or disappearance during build', async () => {
  const wrongMint = fixture(true); const wrongOutput = deriveAssociatedTokenAddress(wrongMint.wallet.publicKey.toBase58(), wrongMint.outputMint); wrongMint.rpc.accounts.set(wrongOutput, tokenAccount(wrongMint.wallet.publicKey.toBase58(), wrongMint.inputMint, 0n));
  await expectCode(() => wrongMint.engine.createQuote({ walletAddress: wrongMint.wallet.publicKey.toBase58(), network: 'devnet', inputMint: wrongMint.inputMint, outputMint: wrongMint.outputMint, amount: '1', clientRequestId: 'wrong-existing', requestId: 'wrong-existing' }), 'TOKEN_UNSUPPORTED');
  const wrongProgram = fixture(true); const wrongProgramOutput = deriveAssociatedTokenAddress(wrongProgram.wallet.publicKey.toBase58(), wrongProgram.outputMint); wrongProgram.rpc.accounts.set(wrongProgramOutput, { ...tokenAccount(wrongProgram.wallet.publicKey.toBase58(), wrongProgram.outputMint, 0n), owner: Keypair.generate().publicKey.toBase58() });
  await expectCode(() => wrongProgram.engine.createQuote({ walletAddress: wrongProgram.wallet.publicKey.toBase58(), network: 'devnet', inputMint: wrongProgram.inputMint, outputMint: wrongProgram.outputMint, amount: '1', clientRequestId: 'wrong-program', requestId: 'wrong-program' }), 'TOKEN_UNSUPPORTED');
  const disappeared = fixture(true); disappeared.rpc.disappearAfterFirstRead = deriveAssociatedTokenAddress(disappeared.wallet.publicKey.toBase58(), disappeared.outputMint);
  await expectCode(() => disappeared.engine.createQuote({ walletAddress: disappeared.wallet.publicKey.toBase58(), network: 'devnet', inputMint: disappeared.inputMint, outputMint: disappeared.outputMint, amount: '1', clientRequestId: 'disappeared', requestId: 'disappeared' }), 'JUPITER_ROUTE_REJECTED');
});

test('reverse Swap settlement requires the exact initialized canonical treasury input-mint accounts', async () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>, address: string) => void]> = [
    ['missing', (f, address) => { f.rpc.accounts.delete(address); }],
    ['wrong owner', (f, address) => { f.rpc.accounts.set(address, tokenAccount(f.wallet.publicKey.toBase58(), f.inputMint, 0n)); }],
    ['wrong mint', (f, address) => { f.rpc.accounts.set(address, tokenAccount(f.reimbursement, f.outputMint, 0n)); }],
    ['wrong token program', (f, address) => { f.rpc.accounts.set(address, { ...tokenAccount(f.reimbursement, f.inputMint, 0n), owner: Keypair.generate().publicKey.toBase58() }); }],
    ['frozen', (f, address) => { f.rpc.accounts.set(address, tokenAccount(f.reimbursement, f.inputMint, 0n, 2)); }],
  ];
  for (const [name, mutate] of cases) {
    const f = fixture(true); const address = deriveAssociatedTokenAddress(f.reimbursement, f.inputMint); mutate(f, address);
    await expectCode(() => f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: `settlement-${name}`, requestId: `settlement-${name}` }), 'CONFIGURATION_ERROR');
    assert.equal(f.jupiter.builds, 0);
  }
});

test('frozen pilot input account fails closed before routing', async () => {
  const f = fixture(true); const source = deriveAssociatedTokenAddress(f.wallet.publicKey.toBase58(), f.inputMint);
  f.rpc.accounts.set(source, tokenAccount(f.wallet.publicKey.toBase58(), f.inputMint, 100_000_000n, 2));
  await expectCode(() => f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: 'frozen-source', requestId: 'frozen-source' }), 'TOKEN_UNSUPPORTED');
  assert.equal(f.jupiter.builds, 0);
});

test('treasury settlement account disappearance after quote fails closed before preparation', async () => {
  const f = fixture(true); const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: 'settlement-disappears', requestId: 'settlement-disappears' });
  f.rpc.accounts.delete(deriveAssociatedTokenAddress(f.reimbursement, f.inputMint));
  await expectCode(() => f.engine.prepare(quote.quoteId, f.wallet.publicKey.toBase58(), 'settlement-disappears-prepare'), 'CONFIGURATION_ERROR');
  assert.equal(f.rpc.simulations, 0); assert.equal(f.durable.transactions.size, 0);
});

test('Swap reimbursement and fee settle only to canonical treasury ATAs for the exact input mint', async () => {
  const f = fixture(true); const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: 'exact-settlement', requestId: 'exact-settlement' });
  assert.equal(quote.swap?.reimbursementDestination, deriveAssociatedTokenAddress(f.reimbursement, f.inputMint));
  assert.equal(quote.swap?.serviceFeeDestination, deriveAssociatedTokenAddress(f.service, f.inputMint));
  assert.equal(quote.swap?.outputAtaRentLamports, '0');
});

test('SWAP quote remains retrievable through normal review time and expires at its configured TTL', async () => {
  let clock = Date.now();
  const f = fixture(false, () => clock);
  const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: 'ttl', requestId: 'ttl' });
  clock += 100_000;
  assert.equal((await f.temporary.getQuote(quote.quoteId))?.quoteId, quote.quoteId);
  clock += 21_000;
  assert.equal(await f.temporary.getQuote(quote.quoteId), null);
});

test('SWAP stabilization persists one final authoritative quote after more than three cost passes', async () => {
  const f = fixture(true);
  f.rpc.fees.push(5_000, 6_000, 7_000, 7_000);
  const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: 'stabilize', requestId: 'stabilize' });
  assert.equal(f.jupiter.builds, 4);
  assert.equal(quote.swap?.networkFeeLamports, '7000');
  assert.equal(f.durable.intents.size, 1);
  assert.equal((await f.temporary.getQuote(quote.quoteId))?.quoteId, quote.quoteId);
});

test('successful Swap reconciliation releases its reservation exactly through the risk boundary', async () => {
  let releases = 0;
  const f = fixture(false, Date.now, { async releaseQuoteExposure() { releases += 1; return 'released'; } });
  const quote = await f.engine.createQuote({ walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet', inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: 'success-release', requestId: 'success-release' });
  const prepared = await f.engine.prepare(quote.quoteId, f.wallet.publicKey.toBase58(), 'prepare-success'); const swap = prepared.swap!;
  const payer = f.relayer.publicKey.toBase58(); const source = swap.inputToken.sourceAccount; const output = swap.outputAccount;
  const reimbursement = deriveAssociatedTokenAddress(f.reimbursement, f.inputMint); const service = deriveAssociatedTokenAddress(f.service, f.inputMint);
  const addresses = [payer, source, output, reimbursement, service]; const balance = (amount: bigint) => ({ amount: amount.toString(), decimals: 6 });
  (f.rpc as Rpc & { getTransaction(signature: string): Promise<unknown> }).getTransaction = async () => ({ slot: 1, transaction: { message: { accountKeys: addresses } }, meta: { err: null, fee: Number(swap.networkFeeLamports), preBalances: [3_000_000, 0, 0, 0, 0], postBalances: [3_000_000 - Number(swap.sponsoredCostLamports), 0, 0, 0, 0], preTokenBalances: [{ accountIndex: 1, mint: f.inputMint, uiTokenAmount: balance(BigInt(swap.totalInputRaw)) }, { accountIndex: 2, mint: f.outputMint, uiTokenAmount: balance(0n) }, { accountIndex: 3, mint: f.inputMint, uiTokenAmount: balance(0n) }, { accountIndex: 4, mint: f.inputMint, uiTokenAmount: balance(0n) }], postTokenBalances: [{ accountIndex: 1, mint: f.inputMint, uiTokenAmount: balance(0n) }, { accountIndex: 2, mint: f.outputMint, uiTokenAmount: balance(BigInt(swap.minimumOutputRaw)) }, { accountIndex: 3, mint: f.inputMint, uiTokenAmount: balance(BigInt(swap.sponsorReimbursementRaw)) }, { accountIndex: 4, mint: f.inputMint, uiTokenAmount: balance(BigInt(swap.serviceFeeRaw)) }] } });
  const result = await (f.engine as unknown as { reconcile(value: typeof prepared, confirmation: { signature: string; outcome: string }): Promise<{ status: string }> }).reconcile(prepared, { signature: 'confirmed', outcome: 'confirmed_success' });
  assert.equal(result.status, 'confirmed'); assert.equal(releases, 1);
  assert.ok([...f.durable.events.values()].some((event) => (event as { eventType?: string }).eventType === 'sponsorship_reservation_released'));
});

test('SWAP quote rejects same mint, unsupported direction, invalid slippage, wrong wallet, and duplicate use', async () => { const f = fixture(true); const base = { walletAddress: f.wallet.publicKey.toBase58(), network: 'devnet' as const, inputMint: f.inputMint, outputMint: f.outputMint, amount: '1', clientRequestId: 'a', requestId: 'a' }; await expectCode(() => f.engine.createQuote({ ...base, outputMint: f.inputMint }), 'INVALID_REQUEST'); await expectCode(() => f.engine.createQuote({ ...base, inputMint: f.outputMint, clientRequestId: 'b' }), 'TOKEN_UNSUPPORTED'); await expectCode(() => f.engine.createQuote({ ...base, slippageBps: 75, clientRequestId: 'c' }), 'INVALID_REQUEST'); const quote = await f.engine.createQuote({ ...base, clientRequestId: 'd' }); await expectCode(() => f.engine.prepare(quote.quoteId, Keypair.generate().publicKey.toBase58(), 'wrong'), 'SESSION_ERROR'); await expectCode(() => f.engine.createQuote({ ...base, clientRequestId: 'd', requestId: 'again' }), 'REPLAY_DETECTED'); });
