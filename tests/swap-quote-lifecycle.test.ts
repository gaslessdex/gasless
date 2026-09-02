import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canOpenWalletForSwap,
  canSubmitSignedSwap,
  confettiParticleCount,
  createSwapSuccessFeedbackLifecycle,
  discoveryReflectsSwapSettlement,
  quoteIdForPrepare,
  quoteRefreshDelay,
  shouldAcceptQuote,
  shouldRefreshQuoteAfterPrepareError,
} from '../src/features/swap/quoteLifecycle.js';
import type { SwapDiscoveryResult } from '../shared/transactions/types.js';

test('displayed quote ID is the only ID eligible for REVIEW & SWAP while fresh', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z');
  const expiresAt = new Date(now + 120_000).toISOString();
  assert.equal(quoteIdForPrepare('quote-ready', 'displayed-quote', expiresAt, now), 'displayed-quote');
  assert.equal(quoteIdForPrepare('refreshing-quote', 'displayed-quote', expiresAt, now), null);
  assert.equal(quoteIdForPrepare('quote-ready', 'displayed-quote', new Date(now + 15_000).toISOString(), now), null);
});

test('quote refresh is scheduled before backend expiry and never extends stale terms', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z');
  assert.equal(quoteRefreshDelay(new Date(now + 120_000).toISOString(), now), 75_000);
  assert.equal(quoteRefreshDelay(new Date(now + 10_000).toISOString(), now), 0);
  assert.equal(quoteRefreshDelay(undefined, now), 0);
});

test('an older debounced or in-flight response cannot replace the newest quote', () => {
  assert.equal(shouldAcceptQuote(2, 1), false);
  assert.equal(shouldAcceptQuote(2, 2), true);
  assert.equal(shouldAcceptQuote(2, 2, true), false);
});

test('missing and expired prepare quotes recover to a fresh review instead of a dead button', () => {
  for (const code of ['QUOTE_NOT_FOUND', 'QUOTE_EXPIRED', 'MESSAGE_MISMATCH']) assert.equal(shouldRefreshQuoteAfterPrepareError(code), true);
  assert.equal(shouldRefreshQuoteAfterPrepareError('INSUFFICIENT_BALANCE'), false);
  assert.equal(shouldRefreshQuoteAfterPrepareError(undefined), false);
});

test('wallet opens once only with a sufficient server signing window and late signatures never submit', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z');
  const accepted = new Date(now + 30_000).toISOString();
  assert.equal(canOpenWalletForSwap(accepted, now), true);
  assert.equal(canOpenWalletForSwap(new Date(now + 24_999).toISOString(), now), false);
  assert.equal(canSubmitSignedSwap(accepted, now + 29_999), true);
  assert.equal(canSubmitSignedSwap(accepted, now + 30_000), false);
});

test('confetti is dense on desktop, bounded on mobile, and disabled for reduced motion', () => {
  assert.equal(confettiParticleCount(1440, false), 92);
  assert.equal(confettiParticleCount(390, false), 48);
  assert.equal(confettiParticleCount(1440, true), 0);
});

test('success feedback survives quote rerenders, fires once, and expires on its original deadline', () => {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { callback: () => void; due: number }>();
  const toasts: Array<string | undefined> = [];
  const confetti: number[] = [];
  const lifecycle = createSwapSuccessFeedbackLifecycle({
    schedule: (callback, delayMs) => { const timer = nextTimer++; timers.set(timer, { callback, due: now + delayMs }); return timer; },
    cancel: (timer) => timers.delete(timer as number),
    showToast: (signature) => toasts.push(signature),
    showConfetti: (count) => confetti.push(count),
  });
  const advance = (milliseconds: number) => {
    now += milliseconds;
    for (const [timer, pending] of [...timers].sort((left, right) => left[1].due - right[1].due)) {
      if (pending.due <= now) { timers.delete(timer); pending.callback(); }
    }
  };

  assert.equal(lifecycle.show('signature-one', 92), true);
  advance(4_000);
  assert.equal(lifecycle.show('signature-one', 92), false);
  assert.deepEqual(toasts, ['signature-one']);
  assert.deepEqual(confetti, [92, 0]);
  advance(2_499);
  assert.deepEqual(toasts, ['signature-one']);
  advance(1);
  assert.deepEqual(toasts, ['signature-one', undefined]);
  assert.equal(lifecycle.show('signature-one', 92), false);
});

test('SWAP AGAIN clears success feedback and a new signature replaces the old transaction link', () => {
  let nextTimer = 1;
  const cancelled: unknown[] = [];
  let toast: string | undefined;
  let confetti = 0;
  const lifecycle = createSwapSuccessFeedbackLifecycle({
    schedule: () => nextTimer++,
    cancel: (timer) => cancelled.push(timer),
    showToast: (signature) => { toast = signature; },
    showConfetti: (count) => { confetti = count; },
  });

  lifecycle.show('signature-one', 48);
  lifecycle.clear();
  assert.equal(toast, undefined);
  assert.equal(confetti, 0);
  assert.equal(cancelled.length, 2);
  assert.equal(lifecycle.show('signature-two', 48), true);
  assert.equal(toast, 'signature-two');
  assert.equal(lifecycle.show('signature-one', 48), false);
  assert.equal(toast, 'signature-two');
});

test('post-success discovery must replace both sides of the pre-swap snapshot before reuse', () => {
  const discovery = (inputRaw: string | undefined, outputRaw: string | undefined) => ({ walletAddress: 'wallet', network: 'devnet', scannedAt: new Date().toISOString(), inputTokens: inputRaw === undefined ? [] : [{ mint: 'USDC', symbol: 'USDC', decimals: 6, tokenProgram: 'token', balanceRaw: inputRaw, sourceAccount: 'input-ata', swapInputEnabled: true, swapOutputEnabled: false }], outputTokens: [{ mint: 'USDT', symbol: 'USDT', decimals: 6, tokenProgram: 'token', balanceRaw: outputRaw, sourceAccount: 'output-ata', outputAtaExists: true, swapInputEnabled: false, swapOutputEnabled: true }] }) as SwapDiscoveryResult;
  assert.equal(discoveryReflectsSwapSettlement(discovery('3000000', '2779930'), 'USDC', '3000000', 'USDT', '2779930'), false);
  assert.equal(discoveryReflectsSwapSettlement(discovery('2000000', '2779930'), 'USDC', '3000000', 'USDT', '2779930'), false);
  assert.equal(discoveryReflectsSwapSettlement(discovery('2000000', '3775965'), 'USDC', '3000000', 'USDT', '2779930'), true);
  assert.equal(discoveryReflectsSwapSettlement(discovery(undefined, '996035'), 'USDC', '3000000', 'USDT'), true);
});
