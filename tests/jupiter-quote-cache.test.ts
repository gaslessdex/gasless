import assert from 'node:assert/strict';
import test from 'node:test';
import { JupiterService, RAYDIUM_CLMM_DEX, WRAPPED_SOL_MINT } from '../server/jupiter/service.js';

test('identical concurrent Jupiter previews coalesce while distinct amounts do not', async () => {
  const inputMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  let calls = 0;
  const request = (async (input: string | URL | Request) => {
    calls += 1; await Promise.resolve();
    const url = new URL(String(input)); const amount = url.searchParams.get('amount')!;
    return new Response(JSON.stringify({ inputMint, outputMint: WRAPPED_SOL_MINT, inAmount: amount, outAmount: '1000', otherAmountThreshold: '990', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.001', routePlan: [{ swapInfo: { label: RAYDIUM_CLMM_DEX, inputMint, outputMint: WRAPPED_SOL_MINT, inAmount: amount, outAmount: '1000' }, bps: 10_000 }] }), { status: 200 });
  }) as typeof fetch;
  const router = new JupiterService('https://api.jup.ag/swap/v2', 'test', request);
  const base = { inputMint, amount: '100', slippageBps: 50, dexes: [RAYDIUM_CLMM_DEX] };
  await Promise.all([router.quote(base), router.quote(base), router.quote({ ...base })]);
  assert.equal(calls, 1);
  await router.quote({ ...base, amount: '101' });
  assert.equal(calls, 2);
});
