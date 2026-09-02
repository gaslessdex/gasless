import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Burn UI uses one wallet invocation behind the server-issued signing window', () => {
  const source = readFileSync('src/features/clean/components/BurnConsole.tsx', 'utf8');
  const submit = source.slice(source.indexOf('const submit = async'), source.indexOf('const busy ='));
  assert.equal(source.match(/wallet\.signTransaction\(/g)?.length, 1);
  assert.ok(submit.indexOf("'/api/burn/prepare'") < submit.indexOf('wallet.signTransaction('));
  assert.ok(submit.indexOf("'/api/burn/blockheight'") < submit.indexOf('wallet.signTransaction('));
  assert.match(submit, /awaitWalletApproval/);
  assert.match(submit, /'\/api\/burn\/wallet-blockheight'/);
  assert.match(submit, /'\/api\/burn\/wallet-event'/);
  assert.match(submit, /'\/api\/burn\/abort-wallet-approval'/);
  assert.match(submit, /'\/api\/burn\/abort-wallet-gate'/);
});

test('Burn review makes the destructive full balance and complete SOL economics explicit', () => {
  const source = readFileSync('src/features/clean/components/BurnConsole.tsx', 'utf8');
  assert.match(source, /permanently destroys your entire/);
  assert.match(source, /This cannot be undone/);
  assert.match(source, /FULL BALANCE ONLY/);
  assert.match(source, /ACCOUNT SOL RECOVERED/);
  assert.match(source, /GASLESS SERVICE FEE \(3% OF RENT\)/);
  assert.match(source, /SPONSORED NETWORK COST/);
  assert.match(source, /SOL RETURNED TO YOU/);
  assert.match(source, /recoverValueAvailable && <p>Want to keep the value instead\? Use Recover Value\.<\/p>/);
});

test('Burn HTTP preparation reserves once before the wallet window and exposes read-only reconciliation', () => {
  const source = readFileSync('server/index.ts', 'utf8');
  const prepare = source.slice(source.indexOf("url.pathname === '/api/burn/prepare'"), source.indexOf("url.pathname === '/api/burn/blockheight'"));
  assert.equal(prepare.match(/reserveTransactionExposure\(/g)?.length, 1);
  assert.ok(prepare.indexOf('reserveTransactionExposure(') < prepare.indexOf('activateSigningWindow('));
  assert.match(prepare, /abortBeforeWallet/);
  assert.match(source, /url\.pathname === '\/api\/burn\/status'/);
  assert.match(source, /reconcileStatus/);
});

test('Burn refresh reconciles durably without rebroadcast and refreshes discovery after success', () => {
  const source = readFileSync('src/features/clean/components/BurnConsole.tsx', 'utf8');
  const submit = source.slice(source.indexOf('const submit = async'), source.indexOf('const busy ='));
  const refresh = source.slice(source.indexOf('const refreshAfterSuccess'), source.indexOf('const scan = async'));
  assert.match(source, /'\/api\/burn\/status'/);
  assert.equal(source.match(/'\/api\/burn\/submit'/g)?.length, 1);
  assert.match(submit, /result\.reconciliation\.status !== 'confirmed'/);
  assert.ok(submit.indexOf("'/api/burn/submit'") < submit.indexOf('refreshAfterSuccess('));
  assert.match(refresh, /'\/api\/burn\/discover'/);
});
