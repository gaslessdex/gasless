import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BurnAccount, BurnDiscoveryResult } from '../shared/transactions/types.js';
import { BURN_SUCCESS_RESET_MS, discoveryReflectsBurnSettlement } from '../src/features/clean/burnLifecycle.js';

const account = (address: string): BurnAccount => ({ address, mint: `${address}-mint`, tokenProgram: 'legacy-token', tokenAmountRaw: '10', decimals: 1, recoverableLamports: '2039280', mintSupplyRaw: '10', stateFingerprint: `${address}-state`, eligible: true });
const discovery = (accounts: BurnAccount[]): BurnDiscoveryResult => ({ walletAddress: 'wallet', network: 'mainnet-beta', scannedAt: new Date().toISOString(), walletBalanceLamports: '3861204', accounts, eligibleAccounts: accounts.filter((item) => item.eligible), skippedAccounts: accounts.filter((item) => !item.eligible) });

test('Burn post-success discovery is authoritative only after the closed account disappears', () => {
  const burned = account('burned-ata'); const usdc = account('usdc-ata');
  assert.equal(discoveryReflectsBurnSettlement(discovery([burned, usdc]), burned.address), false);
  assert.equal(discoveryReflectsBurnSettlement(discovery([usdc]), burned.address), true);
  assert.equal(BURN_SUCCESS_RESET_MS, 1_800);
});

test('successful Burn clears destructive form state, refreshes balances, and preserves its transaction link', () => {
  const source = readFileSync('src/features/clean/components/BurnConsole.tsx', 'utf8');
  const refresh = source.slice(source.indexOf('const refreshAfterSuccess'), source.indexOf('const scan = async'));
  const submit = source.slice(source.indexOf('const submit = async'), source.indexOf('const busy ='));
  assert.ok(submit.indexOf("result.reconciliation.status !== 'confirmed'") < submit.indexOf('refreshAfterSuccess('));
  assert.match(refresh, /setSelected\(undefined\); setConfirmed\(false\)/);
  assert.match(refresh, /'\/api\/burn\/discover'/);
  assert.match(refresh, /discoveryReflectsBurnSettlement/);
  assert.match(source, /walletBalanceLamports/);
  assert.match(refresh, /state: discovery!\.eligibleAccounts\.length \? 'selecting' : 'empty'/);
  assert.doesNotMatch(refresh, /burn:/);
  assert.match(source, /lastConfirmedSignature/);
  assert.match(source, /VIEW TRANSACTION/);
});

test('Burn uses one-shot shared confetti and a dismissible expiring transaction toast only after confirmation', () => {
  const source = readFileSync('src/features/clean/components/BurnConsole.tsx', 'utf8');
  assert.match(source, /createSwapSuccessFeedbackLifecycle/);
  assert.match(source, /confettiParticleCount/);
  assert.match(source, /swap-confetti/);
  assert.match(source, /Burn complete ·/);
  assert.match(source, /Dismiss Burn completion/);
  assert.match(source, /setSuccessToast\(undefined\)/);
  assert.match(source, /explorerTransactionUrl\(successToast\)/);
  assert.doesNotMatch(source.slice(source.indexOf('} catch (error) {'), source.indexOf('} finally {')), /showSuccess/);
});

test('Burn token selection remains explicit and unknown metadata has a safe shortened-mint fallback', () => {
  const source = readFileSync('src/features/clean/components/BurnConsole.tsx', 'utf8');
  assert.match(source, /getSolanaTokenMetadata\(account\.mint\)/);
  assert.match(source, /symbol: metadata\?\.symbol \?\? `TOKEN \$\{shortMint\(account\.mint\)\}`/);
  assert.match(source, /name: metadata\?\.name \?\? 'Legacy SPL token'/);
  assert.match(source, /value=\{selectedToken\}/);
  assert.match(source, /onChange=\{\(token\)/);
  assert.doesNotMatch(source, /eligibleAccounts\[0\]/);
});
