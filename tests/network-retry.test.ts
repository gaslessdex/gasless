import assert from 'node:assert/strict';
import test from 'node:test';
import { requestWithBackoff, retryDelayMs } from '../server/network/retry.js';

test('429 retry respects Retry-After and remains bounded', async () => {
  let calls = 0; const delays: number[] = []; const events: Array<number | string> = [];
  const response = await requestWithBackoff(async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '2' } }) : new Response('ok'), { attempts: 2, sleep: async (delay) => { delays.push(delay); }, onRetry: (status) => events.push(status) });
  assert.equal(response.status, 200); assert.equal(calls, 2); assert.deepEqual(delays, [2_000]); assert.deepEqual(events, [429]);
});

test('backoff adds bounded jitter and never creates an unbounded retry storm', async () => {
  assert.equal(retryDelayMs(0, null, () => 0), 250);
  assert.equal(retryDelayMs(10, null, () => 1), 4_151);
  let calls = 0;
  const result = await requestWithBackoff(async () => { calls += 1; return new Response('', { status: 503 }); }, { attempts: 99, sleep: async () => undefined, random: () => 0 });
  assert.equal(result.status, 503); assert.equal(calls, 3);
});
