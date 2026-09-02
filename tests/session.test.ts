import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { SessionService } from '../server/session/service.js';
import { MemoryTemporaryStore } from '../server/storage/temporary.js';
import { GaslessError } from '../server/errors.js';

test('wallet sessions survive across application instances through shared temporary storage', async () => {
  const temporary = new MemoryTemporaryStore();
  const first = new SessionService(temporary, 60, 'mainnet-beta');
  const second = new SessionService(temporary, 60, 'mainnet-beta');
  const wallet = Keypair.generate().publicKey.toBase58();
  const session = await first.create(wallet, 'mainnet-beta', 'create');
  assert.equal((await second.require(session.sessionId, wallet)).walletAddress, wallet);
});

test('cross-instance session survives a realistic Recover review delay', async () => {
  let now = 1_000; const temporary = new MemoryTemporaryStore(() => now); const first = new SessionService(temporary, 90, 'mainnet-beta'); const second = new SessionService(temporary, 90, 'mainnet-beta'); const wallet = Keypair.generate().publicKey.toBase58(); const session = await first.create(wallet, 'mainnet-beta', 'prepare'); now += 45_000; assert.equal((await second.require(session.sessionId, wallet)).sessionId, session.sessionId);
});

test('wallet sessions still fail closed for expiry and wallet mismatch', async () => {
  let now = 1_000;
  const temporary = new MemoryTemporaryStore(() => now);
  const service = new SessionService(temporary, 1, 'mainnet-beta');
  const wallet = Keypair.generate().publicKey.toBase58();
  const session = await service.create(wallet, 'mainnet-beta', 'create');
  await assert.rejects(() => service.require(session.sessionId, Keypair.generate().publicKey.toBase58()), (error: unknown) => error instanceof GaslessError && error.code === 'SESSION_ERROR');
  now += 1_001;
  await assert.rejects(() => service.require(session.sessionId, wallet), (error: unknown) => error instanceof GaslessError && error.code === 'SESSION_ERROR');
});
