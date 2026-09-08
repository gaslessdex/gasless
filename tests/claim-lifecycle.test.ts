import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ClaimAccount, ClaimDiscoveryResult } from '../shared/transactions/types.js';
import { discoveryReflectsClaimSettlement, nonemptySkippedAccountCount } from '../src/features/clean/claimLifecycle.js';

function account(address: string, amount: string, eligible: boolean): ClaimAccount {
  return { address, mint: `${address}-mint`, tokenProgram: 'legacy-token', tokenAmountRaw: amount, recoverableLamports: '2039280', stateFingerprint: `${address}-state`, eligible, reason: eligible ? undefined : 'This token account still contains tokens.' };
}

function discovery(accounts: ClaimAccount[]): ClaimDiscoveryResult {
  return { walletAddress: 'wallet', network: 'mainnet-beta', scannedAt: new Date().toISOString(), walletBalanceLamports: '1930602', accounts, eligibleAccounts: accounts.filter((item) => item.eligible), skippedAccounts: accounts.filter((item) => !item.eligible) };
}

test('post-Claim discovery is accepted only after every closed account disappears', () => {
  const closed = account('closed-jup-ata', '0', true);
  const usdc = account('usdc-ata', '2011291', false);
  assert.equal(discoveryReflectsClaimSettlement(discovery([closed, usdc]), [closed.address]), false);
  assert.equal(discoveryReflectsClaimSettlement(discovery([usdc]), [closed.address]), true);
});

test('skipped wording counts only nonempty accounts and disappears at zero', () => {
  assert.equal(nonemptySkippedAccountCount(discovery([account('usdc', '2011291', false), account('usdt', '1779926', false), account('unsupported-empty', '0', false)])), 2);
  assert.equal(nonemptySkippedAccountCount(discovery([account('unsupported-empty', '0', false)])), 0);
  assert.equal(nonemptySkippedAccountCount(undefined), 0);
});

test('Claim success clears stale economics, refreshes authoritatively, and preserves the transaction link', () => {
  const source = readFileSync('src/features/clean/components/ClaimConsole.tsx', 'utf8');
  const refresh = source.slice(source.indexOf('const refreshAfterSuccess'), source.indexOf('const scan = async'));
  assert.match(refresh, /setView\(\{ state: 'confirmed', sessionId, signatures \}\)/);
  assert.match(refresh, /'\/api\/claim\/discover'/);
  assert.match(refresh, /discoveryReflectsClaimSettlement/);
  assert.match(refresh, /state: discovery\.eligibleAccounts\.length \? 'results' : 'empty'/);
  assert.doesNotMatch(refresh, /\/api\/claim\/quote/);
  assert.match(source, /Wallet SOL balance/);
  assert.match(source, /transactionSignatures\.map/);
});

test('Claim empty state is current, non-actionable, and supports a future safe rescan', () => {
  const source = readFileSync('src/features/clean/components/ClaimConsole.tsx', 'utf8');
  assert.match(source, /view\.state === 'empty' \? 'NO SOL TO CLAIM'/);
  assert.match(source, /disabled=\{claimBusy \|\| view\.state === 'confirmed' \|\| view\.state === 'empty'\}/);
  assert.match(source, /No empty token accounts are ready to clean\./);
  assert.match(source, /className="claim-rescan"[\s\S]*?SCAN AGAIN/);
  assert.match(source, /displayedRecoverable = view\.state === 'empty'[\s\S]*?\? '0'/);
});

test('Claim initial scan uses one quote-and-discovery request and click enters PREPARING synchronously', () => {
  const source = readFileSync('src/features/clean/components/ClaimConsole.tsx', 'utf8');
  const scan = source.slice(source.indexOf('const scan = async'), source.indexOf('useEffect(() => {', source.indexOf('const scan = async')));
  assert.match(scan, /api<\{ quoteId\?: string; discovery: ClaimDiscoveryResult/);
  assert.doesNotMatch(scan, /api<ClaimDiscoveryResult>\('\/api\/claim\/discover'/);
  const submit = source.slice(source.indexOf('const submitClaim = async'), source.indexOf('const claimBusy'));
  assert.ok(submit.indexOf("state: 'preparing'") < submit.indexOf("'/api/claim/prepare'"));
  assert.match(source, /aria-busy=\{claimBusy\}/);
});

test('Claim confetti can fire only after authoritative confirmed status and remains signature-deduplicated', () => {
  const source = readFileSync('src/features/clean/components/ClaimConsole.tsx', 'utf8');
  const submit = source.slice(source.indexOf('const submitClaim = async'), source.indexOf('const claimBusy'));
  assert.ok(submit.indexOf("result.reconciliation.status !== 'confirmed'") < submit.indexOf('showSuccess(signatures,'));
  assert.match(source, /createSwapSuccessFeedbackLifecycle/);
  assert.match(source, /confettiParticleCount/);
  assert.match(source, /swap-confetti/);
  assert.doesNotMatch(source.slice(source.indexOf('} catch (error) {'), source.indexOf('} finally {')), /showSuccess/);
});
