import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSendSigningWindow, evaluateSendWalletGate } from '../chains/solana/send/validity.js';
import type { PreparedTransaction } from '../shared/transactions/types.js';
import { canOpenWalletForSend, discoveryReflectsSendSettlement, quoteIdForSendPrepare, shouldAcceptSendPreview, shouldReturnSendToReview } from '../src/features/send/lifecycle.js';
import { sendErrorMessage } from '../src/features/send/errors.js';
import { awaitSendWalletApproval, walletReturnHasSubmissionMargin } from '../src/features/send/walletApproval.js';
import { classifyWalletSigningFailure } from '../src/wallet/walletStandardSigning.js';

function preparedAt(now: number, currentBlockHeight = 50, lastValidBlockHeight = 200) {
  const window = createSendSigningWindow(lastValidBlockHeight, currentBlockHeight, now);
  assert.ok(window);
  return { lastValidBlockHeight, preparedBlockHeight: currentBlockHeight, walletSigningReadyAt: window.readyAt, walletSigningExpiresAt: window.walletSigningExpiresAt, walletSigningWindowMs: window.walletSigningWindowMs } as PreparedTransaction;
}

test('Send accepts only the current unlocked preview and prepares only a fresh reviewed quote', () => {
  const now = Date.now();
  assert.equal(shouldAcceptSendPreview(4, 4), true);
  assert.equal(shouldAcceptSendPreview(5, 4), false);
  assert.equal(shouldAcceptSendPreview(4, 4, true), false);
  assert.equal(quoteIdForSendPrepare('review', 'quote', new Date(now + 46_000).toISOString(), now), 'quote');
  assert.equal(quoteIdForSendPrepare('review', 'quote', new Date(now + 45_000).toISOString(), now), null);
  assert.equal(quoteIdForSendPrepare('checking', 'quote', new Date(now + 60_000).toISOString(), now), null);
});
test('Send refreshes review only for stale or mismatched server preparation', () => {
  assert.equal(shouldReturnSendToReview('QUOTE_NOT_FOUND'), true);
  assert.equal(shouldReturnSendToReview('QUOTE_EXPIRED'), true);
  assert.equal(shouldReturnSendToReview('MESSAGE_MISMATCH'), true);
  assert.equal(shouldReturnSendToReview('SIMULATION_FAILED'), false);
});

test('Send signing lifecycle requires a safe pre-wallet opening margin', () => {
  const now = Date.now();
  const prepared = preparedAt(now);
  assert.equal(canOpenWalletForSend(prepared, now, now), true);
  assert.equal(canOpenWalletForSend(prepared, now, now + 5_001), false);
});

test('wallet-open approval uses chain validity after 5s, 15s, and 30s instead of a wall-clock timeout', async () => {
  for (const elapsedMs of [5_000, 15_000, 30_000]) {
    let reads = 0;
    const outcome = await awaitSendWalletApproval({ sign: async () => new Uint8Array([1]), getBlockHeight: async () => 150, lastValidBlockHeight: 200, now: () => reads++ === 0 ? 0 : elapsedMs, wait: () => new Promise<void>(() => {}) });
    assert.equal(outcome.status, 'signed');
    assert.equal(outcome.elapsedMs, elapsedMs);
  }
  assert.equal(walletReturnHasSubmissionMargin(200, 170), true);
  assert.equal(walletReturnHasSubmissionMargin(200, 171), false);
});

test('pending wallet approval expires only after the last valid block height', async () => {
  const heights = [199, 200, 201]; let index = 0;
  const outcome = await awaitSendWalletApproval({ sign: () => new Promise<Uint8Array>(() => {}), getBlockHeight: async () => heights[index++]!, lastValidBlockHeight: 200, wait: async () => {}, now: () => 0 });
  assert.equal(outcome.status, 'expired');
  assert.equal(outcome.blockHeight, 201);
  assert.equal(index, 3);
});

test('a transient block-height read failure does not abort a returned wallet signature', async () => {
  let reads = 0;
  const outcome = await awaitSendWalletApproval({ sign: async () => new Uint8Array([1]), getBlockHeight: async () => { if (reads++ === 0) throw new Error('temporary RPC failure'); return 150; }, lastValidBlockHeight: 200, wait: async () => {}, now: () => 0 });
  assert.equal(outcome.status, 'signed');
  assert.equal(reads, 2);
});

test('wallet failure classification reserves cancellation copy for explicit rejection evidence', () => {
  assert.equal(classifyWalletSigningFailure(Object.assign(new Error('User rejected the request'), { code: 4001 })), 'USER_EXPLICITLY_CANCELLED');
  assert.equal(classifyWalletSigningFailure(Object.assign(new Error('Wallet Standard rejection'), { code: 4001000 })), 'USER_EXPLICITLY_CANCELLED');
  assert.equal(classifyWalletSigningFailure(new DOMException('wallet timed out', 'TimeoutError')), 'WALLET_SIGNING_TIMEOUT');
  assert.equal(classifyWalletSigningFailure(new DOMException('flow stopped', 'AbortError')), 'APP_ABORTED_SIGNING_FLOW');
  assert.equal(classifyWalletSigningFailure(new Error('provider transport failed')), 'WALLET_PROVIDER_ERROR');
  assert.equal(sendErrorMessage({ code: 'UNKNOWN_WALLET_FAILURE' }, 'wallet'), 'Your wallet could not complete the approval. Nothing was sent.');
});

test('Send exposes exact primary copy for each wallet lifecycle classification', () => {
  assert.equal(sendErrorMessage({ code: 'USER_EXPLICITLY_CANCELLED' }, 'wallet'), 'Transaction cancelled in your wallet. Nothing was sent.');
  assert.equal(sendErrorMessage({ code: 'WALLET_PROVIDER_ERROR', message: 'raw provider transport failure' }, 'wallet'), 'Your wallet could not complete the approval. Nothing was sent.');
  assert.equal(sendErrorMessage({ code: 'TRANSACTION_EXPIRED_WHILE_WALLET_OPEN' }, 'wallet'), 'Transaction expired while awaiting wallet approval. Nothing was sent. Review the updated costs and try again.');
  assert.equal(sendErrorMessage({ code: 'PREPARATION_EXPIRED_BEFORE_WALLET' }, 'prepare'), 'Send preparation expired before wallet approval. Review the updated costs and try again.');
});

test('Send accessibility alert announces the same mapped primary copy', () => {
  const source = readFileSync('src/features/send/components/SendConsole.tsx', 'utf8');
  assert.match(source, /view\.error && <p className="connection-message" role="alert">\{view\.error\}<\/p>/);
});

test('1s, 5s, and 10s server preparation do not consume the client wallet window', () => {
  const requestAt = 1_000_000;
  for (const preparationMs of [1_000, 5_000, 10_000]) {
    const armedAt = requestAt + preparationMs;
    const prepared = preparedAt(armedAt);
    const responseParsedAt = armedAt + 250;
    const gate = evaluateSendWalletGate(prepared, responseParsedAt, responseParsedAt);
    assert.equal(gate.allowed, true);
    assert.equal(gate.remainingWalletMs, 30_000);
    assert.equal(prepared.walletSigningReadyAt, new Date(armedAt).toISOString());
  }
});

test('bounded response latency preserves a client-received signing window', () => {
  const armedAt = 2_000_000; const prepared = preparedAt(armedAt); const responseParsedAt = armedAt + 10_000;
  const gate = evaluateSendWalletGate(prepared, responseParsedAt, responseParsedAt);
  assert.equal(gate.allowed, true);
  assert.equal(gate.remainingWalletMs, 30_000);
});

test('Send wallet gate rejects unsafe blockheight and a truly expired deadline', () => {
  const now = 3_000_000; const prepared = preparedAt(now, 100, 200);
  assert.equal(evaluateSendWalletGate(prepared, now, now, 101).reason, 'blockhash_margin');
  assert.equal(evaluateSendWalletGate(prepared, now, now).reason, 'safe');
  assert.equal(evaluateSendWalletGate(prepared, now, now + 20_001).reason, 'wallet_deadline');
});

test('Post-Send discovery must authoritatively reflect the source debit before reuse', () => {
  const discovery = (balanceRaw?: string) => ({ walletAddress: 'wallet', network: 'devnet' as const, scannedAt: new Date().toISOString(), tokens: balanceRaw === undefined ? [] : [{ mint: 'USDC', symbol: 'USDC', decimals: 6, tokenProgram: 'token', balanceRaw, sourceAccount: 'ata' }] });
  assert.equal(discoveryReflectsSendSettlement(discovery('1000000'), 'USDC', '1000000'), false);
  assert.equal(discoveryReflectsSendSettlement(discovery('499000'), 'USDC', '1000000'), true);
  assert.equal(discoveryReflectsSendSettlement(discovery(), 'USDC', '1000000'), true);
});

test('Send UI locks signing to one wallet invocation and uses temporary success feedback', () => {
  const source = readFileSync('src/features/send/components/SendConsole.tsx', 'utf8');
  assert.equal(source.match(/wallet\.signTransaction\(/g)?.length, 1);
  const previewSource = source.slice(source.indexOf('const preview = async'), source.indexOf('const refreshBalanceAfterSuccess'));
  const submitSource = source.slice(source.indexOf('const submit = async'), source.indexOf('const sendAgain'));
  assert.match(previewSource, /'\/api\/send\/quote'/);
  assert.doesNotMatch(previewSource, /'\/api\/send\/prepare'/);
  assert.match(submitSource, /state: 'preparing'/);
  assert.ok(submitSource.indexOf("'/api/send/prepare'") < submitSource.indexOf('wallet.signTransaction('));
  assert.ok(submitSource.indexOf("'/api/send/blockheight'") < submitSource.indexOf('walletGateForSend('));
  assert.ok(submitSource.indexOf('walletGateForSend(') < submitSource.indexOf('wallet.signTransaction('));
  assert.match(submitSource, /'\/api\/send\/abort-wallet-gate'/);
  assert.match(source, /signingLocked\.current/);
  assert.match(source, /previewGeneration\.current/);
  assert.match(source, /previewRequest\.current\?\.abort\(\)/);
  assert.match(source, /SEND AGAIN/);
  assert.match(source, /createSwapSuccessFeedbackLifecycle/);
  assert.match(source, /refreshBalanceAfterSuccess/);
  assert.match(source, /const busy = \['loading', 'checking', 'preparing', 'awaiting-signature', 'submitting'\]\.includes\(view\.state\)/);
  assert.match(source, /<button className="console-primary" type="button"[\s\S]*?disabled=\{busy \|\|/);
  assert.match(source, /view\.state === 'awaiting-signature' \? 'APPROVE IN WALLET'/);
  assert.doesNotMatch(source, />VIEW TRANSACTION</);
});

test('Send persists redacted provider telemetry while primary UI copy remains generic', () => {
  const source = readFileSync('src/features/send/components/SendConsole.tsx', 'utf8');
  assert.match(source, /providerCode: details\.providerCode/);
  assert.match(source, /providerName: details\.providerName/);
  assert.match(source, /providerMessage: details\.providerMessage/);
  assert.match(source, /mutationDiagnostics: details\.mutationDiagnostics/);
  assert.doesNotMatch(source, /setView\([^\n]*providerMessage/);
});

test('Send HTTP preparation reserves exactly once before arming the wallet window', () => {
  const source = readFileSync('server/index.ts', 'utf8');
  const route = source.slice(source.indexOf("url.pathname === '/api/send/prepare'"), source.indexOf("url.pathname === '/api/send/submit'"));
  assert.equal(route.match(/reserveQuoteExposure\(/g)?.length, 1);
  assert.ok(route.indexOf('reserveQuoteExposure(') < route.indexOf('activateSigningWindow('));
  assert.match(route, /abortBeforeWallet/);
  assert.match(route, /X-Gasless-Send-Response-Enqueued-At/);
});

test('Send errors never expose routing or provider terminology', () => {
  for (const message of ['route not found', 'No swap route', 'Jupiter unavailable', 'Raydium route failed', 'price impact rejected', 'slippage route failure']) {
    const displayed = sendErrorMessage({ code: 'INVALID_REQUEST', message }, 'prepare');
    assert.equal(displayed, 'GASLESS Send is temporarily unavailable. Please try again later.');
    assert.doesNotMatch(displayed, /route|swap|jupiter|raydium|price impact|slippage/i);
  }
  assert.match(sendErrorMessage({ code: 'TOKEN_UNSUPPORTED', message: 'Current server pricing is unavailable.' }, 'prepare'), /pricing is temporarily unavailable/i);
  assert.match(sendErrorMessage({ code: 'INSUFFICIENT_BALANCE' }, 'review'), /smaller amount|MAX/i);
  assert.match(sendErrorMessage({ code: 'INVALID_REQUEST', message: 'Enter a valid Solana wallet address.' }, 'review'), /valid supported Solana wallet address/i);
  assert.match(sendErrorMessage({ code: 'MESSAGE_MISMATCH', message: 'The recipient account changed.' }, 'prepare'), /recipient setup changed/i);
});

test('Send has no executable swap-route dependency and unknown Send APIs use Send-safe copy', () => {
  const engine = readFileSync('server/send/engine.ts', 'utf8');
  const builder = readFileSync('chains/solana/transactions/send.ts', 'utf8');
  const app = readFileSync('server/app.ts', 'utf8');
  const api = readFileSync('server/index.ts', 'utf8');
  const sendConstruction = app.slice(app.indexOf('const send = new SendEngine'), app.indexOf('const swap = new SwapEngine'));
  for (const source of [engine, builder, sendConstruction]) assert.doesNotMatch(source, /JupiterService|JupiterRouter|Raydium|routePlan|slippage|priceImpact|\.build\(/);
  assert.match(sendConstruction, /priceProvider/);
  assert.match(api, /url\.pathname\.startsWith\('\/api\/send\/'\).*GASLESS Send is temporarily unavailable/);
});

test('Send keeps two happy-path actions, treats preparation as status, and cleans a failed final gate', () => {
  const source = readFileSync('src/features/send/components/SendConsole.tsx', 'utf8');
  assert.match(source, /view\.state === 'review' \? 'SIGN & SEND'/);
  assert.match(source, /view\.state === 'preparing' \? 'PREPARING TRANSACTION/);
  assert.match(source, /preparedForWallet/);
  assert.match(source, /reason: 'final_gate_unavailable'/);
  assert.equal(source.match(/wallet\.signTransaction\(/g)?.length, 1);
  assert.doesNotMatch(source, /CONFIRM SEND|CONTINUE TO WALLET/);
});
