import assert from 'node:assert/strict';
import test from 'node:test';
import { loadServerConfig } from '../server/config/env.js';
import { GaslessError } from '../server/errors.js';

const names = [
  'GASLESS_OPERATING_MODE', 'GASLESS_NETWORK', 'SOLANA_RPC_URL',
  'KORA_RPC_URL', 'UPSTASH_REDIS_REST_URL', 'SUPABASE_URL',
  'GLOBAL_SPONSORSHIP_CAP_LAMPORTS', 'WALLET_SPONSORSHIP_CAP_LAMPORTS',
  'PER_TRANSACTION_SPONSORSHIP_CAP_LAMPORTS', 'RELAYER_LOW_BALANCE_THRESHOLD_LAMPORTS',
  'RELAYER_WARNING_BALANCE_THRESHOLD_LAMPORTS',
] as const;

function isolated(values: Partial<Record<(typeof names)[number], string>>, run: () => void) {
  const original = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
    run();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function configurationError(run: () => unknown, message?: RegExp) {
  assert.throws(run, (error: unknown) => error instanceof GaslessError
    && error.code === 'CONFIGURATION_ERROR'
    && (!message || message.test(error.message)));
}

test('private Mainnet rejects an explicit Devnet network', () => isolated({
  GASLESS_OPERATING_MODE: 'private-mainnet', GASLESS_NETWORK: 'devnet',
}, () => configurationError(loadServerConfig, /does not match/)));

test('private Mainnet has no implicit financial limit defaults', () => isolated({
  GASLESS_OPERATING_MODE: 'private-mainnet', GASLESS_NETWORK: 'mainnet-beta',
  SOLANA_RPC_URL: 'https://mainnet.example.invalid',
  KORA_RPC_URL: 'https://kora.example.invalid',
  UPSTASH_REDIS_REST_URL: 'https://redis.example.invalid',
  SUPABASE_URL: 'https://database.example.invalid',
}, () => configurationError(loadServerConfig, /GLOBAL_SPONSORSHIP_CAP_LAMPORTS/)));
