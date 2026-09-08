import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BROWSER_VERIFICATION_COOKIE, BrowserVerificationService, browserVerificationCookie, browserVerificationSession, cookieValue } from '../server/abuse/browser-verification.js';
import { MemoryTemporaryStore } from '../server/storage/temporary.js';

test('browser verification and public liveness remain available while financial startup validation is degraded', () => {
  const source = readFileSync('server/index.ts', 'utf8');
  const independent = source.indexOf("const startupIndependent = url.pathname === '/api/health'");
  const validation = source.indexOf('if (!startupIndependent) await (startupValidation ??= validateStartup())');
  assert.ok(independent > source.indexOf("new URL(request.url ?? '/', 'http://localhost')"));
  assert.ok(validation > independent);
  assert.match(source.slice(independent, validation), /browser-verification/);
  assert.match(source.slice(independent, validation), /public\/status/);
  assert.match(source.slice(independent, validation), /public\/stats/);
});

function service(result: Record<string, unknown>, store = new MemoryTemporaryStore()) {
  const request = async () => new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return { store, service: new BrowserVerificationService(store, { siteKey: 'site', secretKey: 'secret', allowedHostnames: ['gasless.exchange'], ttlSeconds: 900 }, request as typeof fetch) };
}

test('valid Turnstile proof creates a server-held session bound to the browser user agent', async () => {
  const fixture = service({ success: true, hostname: 'gasless.exchange', action: 'gasless-entry' });
  const verified = await fixture.service.verify('valid-token', 'browser-a', crypto.randomUUID());
  const required = await fixture.service.require(verified.sessionId, 'browser-a');
  assert.ok(required);
  assert.equal(required.sessionId, verified.sessionId);
  await assert.rejects(() => fixture.service.require(verified.sessionId, 'browser-b'));
});

test('verified sessions expire in shared temporary storage and challenge outages fail closed', async () => {
  let now = 1_000_000; const store = new MemoryTemporaryStore(() => now);
  const fixture = service({ success: true, hostname: 'gasless.exchange', action: 'gasless-entry' }, store);
  const verified = await fixture.service.verify('expiring-token', 'browser', crypto.randomUUID());
  now += 901_000;
  await assert.rejects(() => fixture.service.require(verified.sessionId, 'browser'));
  const outage = new BrowserVerificationService(store, { siteKey: 'site', secretKey: 'secret', allowedHostnames: ['gasless.exchange'], ttlSeconds: 900 }, (async () => { throw new Error('offline'); }) as typeof fetch);
  await assert.rejects(() => outage.verify('outage-token', 'browser', crypto.randomUUID()));
});

test('invalid hostname, action, failed proof, missing proof, and token replay fail closed', async () => {
  for (const result of [
    { success: false, hostname: 'gasless.exchange', action: 'gasless-entry' },
    { success: true, hostname: 'attacker.example', action: 'gasless-entry' },
    { success: true, hostname: 'gasless.exchange', action: 'different-action' },
  ]) await assert.rejects(() => service(result).service.verify('token', 'browser', crypto.randomUUID()));
  const fixture = service({ success: true, hostname: 'gasless.exchange', action: 'gasless-entry' });
  await assert.rejects(() => fixture.service.require(undefined, 'browser'));
  await fixture.service.verify('one-use-token', 'browser', 'request-one');
  await assert.rejects(() => fixture.service.verify('one-use-token', 'browser', 'request-two'));
});

test('verification cookie is host-only, HTTP-only, and recoverable without exposing server state', () => {
  const header = browserVerificationCookie('session-id', 900, true);
  assert.match(header, new RegExp(`^${BROWSER_VERIFICATION_COOKIE}=session-id;`));
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/); assert.match(header, /Secure/);
  assert.equal(cookieValue(`unrelated=x; ${BROWSER_VERIFICATION_COOKIE}=session-id`), 'session-id');
});

test('local verification uses a valid non-Host cookie and accepts either session cookie', () => {
  const local = browserVerificationCookie('local-session', 900, false);
  assert.match(local, /^gasless_verified=local-session;/); assert.doesNotMatch(local, /; Secure/);
  assert.equal(browserVerificationSession(local), 'local-session');
  assert.equal(browserVerificationSession(`${BROWSER_VERIFICATION_COOKIE}=production-session`), 'production-session');
});

test('an unconfigured verifier has no production bypass', async () => {
  const verifier = new BrowserVerificationService(new MemoryTemporaryStore(), { allowedHostnames: ['gasless.exchange'], ttlSeconds: 900 });
  assert.equal(verifier.configured(), false);
  await assert.rejects(() => verifier.require(undefined, 'browser'));
});
