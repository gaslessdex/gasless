import { createHash, randomUUID } from 'node:crypto';
import type { TemporaryStore } from '../storage/temporary.js';
import { GaslessError } from '../errors.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const BROWSER_VERIFICATION_COOKIE = '__Host-gasless_verified';
const LOCAL_BROWSER_VERIFICATION_COOKIE = 'gasless_verified';
export const TURNSTILE_ACTION = 'gasless-entry';

export interface BrowserVerificationPolicy {
  siteKey?: string;
  secretKey?: string;
  allowedHostnames: string[];
  ttlSeconds: number;
}

interface SiteverifyResponse { success?: boolean; hostname?: string; action?: string; 'error-codes'?: string[] }

function userAgentHash(userAgent: string) { return createHash('sha256').update(userAgent).digest('hex'); }
function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }

export class BrowserVerificationService {
  constructor(private readonly store: TemporaryStore, readonly policy: BrowserVerificationPolicy, private readonly request: typeof fetch = fetch) {}

  enforced() { return true; }
  configured() { return Boolean(this.policy.siteKey && this.policy.secretKey); }

  async verify(token: string, userAgent: string, requestId: string) {
    if (!this.configured()) throw new GaslessError('CONFIGURATION_ERROR', 'browser_verification', 'Browser verification is not configured.');
    if (!token || token.length > 2_048) throw new GaslessError('INVALID_REQUEST', 'browser_verification', "We couldn't verify this browser. Try again.");
    const response = await this.request(SITEVERIFY_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({ secret: this.policy.secretKey, response: token, idempotency_key: requestId }),
    }).catch((error) => { throw new GaslessError('INTERNAL_ERROR', 'browser_verification', "We couldn't verify this browser. Try again.", true, undefined, { cause: error }); });
    const result = await response.json().catch(() => ({})) as SiteverifyResponse;
    if (!response.ok || !result.success || result.action !== TURNSTILE_ACTION || !result.hostname || !this.policy.allowedHostnames.includes(result.hostname.toLowerCase())) throw new GaslessError('SESSION_ERROR', 'browser_verification', "We couldn't verify this browser. Try again.");
    const replayKey = `turnstile:${tokenHash(token)}`;
    if (!await this.store.acquireReplayLock(replayKey, requestId, 300)) throw new GaslessError('REPLAY_DETECTED', 'browser_verification', "We couldn't verify this browser. Try again.");
    const sessionId = randomUUID(); const now = Date.now();
    const session = { sessionId, userAgentHash: userAgentHash(userAgent), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.policy.ttlSeconds * 1000).toISOString() };
    await this.store.saveBrowserVerification(session, this.policy.ttlSeconds);
    return session;
  }

  async require(sessionId: string | undefined, userAgent: string) {
    if (!this.configured()) throw new GaslessError('CONFIGURATION_ERROR', 'browser_verification', 'Browser verification is not configured.');
    const session = sessionId ? await this.store.getBrowserVerification(sessionId) : null;
    if (!session || Date.parse(session.expiresAt) <= Date.now() || session.userAgentHash !== userAgentHash(userAgent)) throw new GaslessError('SESSION_ERROR', 'browser_verification', 'Browser verification expired. Try again.');
    return session;
  }
}

export function cookieValue(cookieHeader: string | undefined, name = BROWSER_VERIFICATION_COOKIE) {
  const prefix = `${name}=`;
  return cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
}

export function browserVerificationCookie(sessionId: string, ttlSeconds: number, secure: boolean) {
  const name = secure ? BROWSER_VERIFICATION_COOKIE : LOCAL_BROWSER_VERIFICATION_COOKIE;
  return `${name}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlSeconds}${secure ? '; Secure' : ''}`;
}

export function browserVerificationSession(cookieHeader: string | undefined) {
  return cookieValue(cookieHeader, BROWSER_VERIFICATION_COOKIE) ?? cookieValue(cookieHeader, LOCAL_BROWSER_VERIFICATION_COOKIE);
}
