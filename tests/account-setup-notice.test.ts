import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { claimAccountSetupNotice } from '../src/components/ui/accountSetupNoticeState.js';

test('missing token-account notices appear once per server-confirmed account key', () => {
  const seen = new Set<string>();
  assert.equal(claimAccountSetupNotice(seen, 'swap:session:USDT', false), true);
  assert.equal(claimAccountSetupNotice(seen, 'swap:session:USDT', false), false);
  assert.equal(claimAccountSetupNotice(seen, 'swap:session:EXISTING', true), false);
  assert.equal(claimAccountSetupNotice(seen, 'swap:session:XAUT', false), true);
  assert.equal(claimAccountSetupNotice(seen, undefined, false), false);
});

test('account setup notice remains timed for Swap and persistent with generic copy for Send', () => {
  const notice = readFileSync('src/components/ui/AccountSetupNotice.tsx', 'utf8');
  const swap = readFileSync('src/features/swap/components/SwapConsole.tsx', 'utf8');
  const send = readFileSync('src/features/send/components/SendConsole.tsx', 'utf8');
  assert.match(notice, /7_000/); assert.match(notice, /if \(recipient\) return/); assert.match(notice, /aria-live="polite"/); assert.match(notice, /Dismiss recipient setup notice/); assert.match(notice, /onClick={onDismiss}/);
  assert.match(notice, /A token account needs to be created/); assert.match(notice, /Recipient setup required/); assert.match(notice, /This wallet is receiving this token for the first time/); assert.doesNotMatch(notice, /\bATA\b|Associated Token Account|\brent\b/i);
  assert.match(send, /`send:\$\{view\.sessionId\}:\$\{view\.quoteId\}`/);
  assert.match(swap, /receiveToken\?\.outputAtaExists/); assert.match(send, /view\.send\?\.recipientAtaExists/);
  assert.match(swap, /<AccountSetupNotice/); assert.match(send, /<AccountSetupNotice/);
});
