import type { TransactionQuote, WalletSession } from '../../shared/transactions/types.js';
import { GaslessError } from '../errors.js';

export interface TemporaryStore {
  saveSession(session: WalletSession, ttlSeconds: number): Promise<void>;
  getSession(sessionId: string): Promise<WalletSession | null>;
  saveQuote(quote: TransactionQuote, ttlSeconds: number): Promise<void>;
  getQuote(quoteId: string): Promise<TransactionQuote | null>;
  setAuthoritativeSwapQuote(key: string, quoteId: string, version: number, ttlSeconds: number): Promise<boolean>;
  isAuthoritativeSwapQuote(key: string, quoteId: string): Promise<boolean>;
  acquireReplayLock(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  hasReplayLock(key: string): Promise<boolean>;
  releaseReplayLockIfSafe(key: string, value: string): Promise<void>;
  consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  reserveSponsorshipExposure(keys: string[], amountLamports: number, limitsLamports: number[], windowSeconds: number, reservationId: string): Promise<boolean>;
  releaseSponsorshipExposure(keys: string[], amountLamports: number, reservationId: string): Promise<'released' | 'already_released'>;
  getSponsorshipExposure(key: string): Promise<number>;
  ping(): Promise<boolean>;
}

export class MemoryTemporaryStore implements TemporaryStore {
  private readonly values = new Map<string, { value: string; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  private current(key: string) {
    const item = this.values.get(key);
    if (item && item.expires <= this.now()) this.values.delete(key);
    return this.values.get(key);
  }

  async saveSession(session: WalletSession, ttlSeconds: number) {
    this.values.set(`gasless:session:${session.sessionId}`, { value: JSON.stringify(session), expires: this.now() + ttlSeconds * 1000 });
  }
  async getSession(sessionId: string) {
    const item = this.current(`gasless:session:${sessionId}`);
    return item ? JSON.parse(item.value) as WalletSession : null;
  }
  async saveQuote(quote: TransactionQuote, ttlSeconds: number) {
    this.values.set(`gasless:quote:${quote.quoteId}`, { value: JSON.stringify(quote), expires: this.now() + ttlSeconds * 1000 });
  }
  async getQuote(quoteId: string) {
    const item = this.current(`gasless:quote:${quoteId}`);
    return item ? JSON.parse(item.value) as TransactionQuote : null;
  }
  async setAuthoritativeSwapQuote(key: string, quoteId: string, version: number, ttlSeconds: number) {
    const namespaced = `gasless:swap-authority:${key}`; const current = this.current(namespaced); const currentVersion = Number(current?.value.split('|', 1)[0] ?? -1);
    if (current && currentVersion > version) return false;
    this.values.set(namespaced, { value: `${version}|${quoteId}`, expires: this.now() + ttlSeconds * 1000 }); return true;
  }
  async isAuthoritativeSwapQuote(key: string, quoteId: string) { return this.current(`gasless:swap-authority:${key}`)?.value.split('|', 2)[1] === quoteId; }
  async acquireReplayLock(key: string, value: string, ttlSeconds: number) {
    const namespaced = `gasless:replay:${key}`;
    if (this.current(namespaced)) return false;
    this.values.set(namespaced, { value, expires: this.now() + ttlSeconds * 1000 });
    return true;
  }
  async hasReplayLock(key: string) { return Boolean(this.current(`gasless:replay:${key}`)); }
  async releaseReplayLockIfSafe(key: string, value: string) {
    const namespaced = `gasless:replay:${key}`;
    if (this.current(namespaced)?.value === value) this.values.delete(namespaced);
  }
  async consumeRateLimit(key: string, limit: number, windowSeconds: number) {
    const namespaced = `gasless:rate:${key}`;
    const item = this.current(namespaced);
    const count = item ? Number(item.value) + 1 : 1;
    this.values.set(namespaced, { value: String(count), expires: item?.expires ?? this.now() + windowSeconds * 1000 });
    return count <= limit;
  }
  async reserveSponsorshipExposure(keys: string[], amount: number, limits: number[], windowSeconds: number, reservationId: string) {
    const reservationKey = `gasless:sponsor-reservation:${reservationId}`;
    if (this.current(reservationKey)) return true;
    if (keys.some((key, index) => Number(this.current(`gasless:sponsor:${key}`)?.value ?? 0) + amount > limits[index])) return false;
    const expires = this.now() + windowSeconds * 1000;
    keys.forEach((key) => { const namespaced = `gasless:sponsor:${key}`; this.values.set(namespaced, { value: String(Number(this.current(namespaced)?.value ?? 0) + amount), expires: this.current(namespaced)?.expires ?? expires }); });
    this.values.set(reservationKey, { value: String(amount), expires });
    return true;
  }
  async releaseSponsorshipExposure(keys: string[], amount: number, reservationId: string) {
    const reservationKey = `gasless:sponsor-reservation:${reservationId}`; const reservation = this.current(reservationKey);
    if (!reservation) return 'already_released' as const;
    if (Number(reservation.value) !== amount) throw new GaslessError('CONFIGURATION_ERROR', 'sponsorship_release', 'The sponsorship reservation amount does not match.');
    const counters = keys.map((key) => ({ key: `gasless:sponsor:${key}`, item: this.current(`gasless:sponsor:${key}`) }));
    if (counters.some(({ item }) => !item || Number(item.value) < amount)) throw new GaslessError('CONFIGURATION_ERROR', 'sponsorship_release', 'The sponsorship counters cannot be safely released.');
    for (const { key, item } of counters) { const next = Number(item!.value) - amount; if (next === 0) this.values.delete(key); else this.values.set(key, { ...item!, value: String(next) }); }
    this.values.delete(reservationKey);
    return 'released' as const;
  }
  async getSponsorshipExposure(key: string) { return Number(this.current(`gasless:sponsor:${key}`)?.value ?? 0); }
  async ping() { return true; }
}

export class UpstashTemporaryStore implements TemporaryStore {
  constructor(private readonly url: string, private readonly token: string) {}

  private async command<T>(parts: Array<string | number>): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parts),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json() as { result?: T; error?: string };
    if (!response.ok || body.error) throw new GaslessError('CONFIGURATION_ERROR', 'redis', 'Temporary transaction state is unavailable.', true);
    return body.result as T;
  }

  async saveSession(session: WalletSession, ttlSeconds: number) {
    await this.command(['SET', `gasless:session:${session.sessionId}`, JSON.stringify(session), 'EX', ttlSeconds]);
  }
  async getSession(sessionId: string) {
    const value = await this.command<string | null>(['GET', `gasless:session:${sessionId}`]);
    return value ? JSON.parse(value) as WalletSession : null;
  }
  async saveQuote(quote: TransactionQuote, ttlSeconds: number) {
    await this.command(['SET', `gasless:quote:${quote.quoteId}`, JSON.stringify(quote), 'EX', ttlSeconds]);
  }
  async getQuote(quoteId: string) {
    const value = await this.command<string | null>(['GET', `gasless:quote:${quoteId}`]);
    return value ? JSON.parse(value) as TransactionQuote : null;
  }
  async setAuthoritativeSwapQuote(key: string, quoteId: string, version: number, ttlSeconds: number) {
    const namespaced = `gasless:swap-authority:${key}`;
    const script = "local value=redis.call('get',KEYS[1]); if value then local split=string.find(value,'|'); local current=tonumber(string.sub(value,1,split-1)); if current>tonumber(ARGV[1]) then return 0 end end; redis.call('set',KEYS[1],ARGV[1]..'|'..ARGV[2],'EX',ARGV[3]); return 1";
    return await this.command<number>(['EVAL', script, 1, namespaced, version, quoteId, ttlSeconds]) === 1;
  }
  async isAuthoritativeSwapQuote(key: string, quoteId: string) { return (await this.command<string | null>(['GET', `gasless:swap-authority:${key}`]))?.split('|', 2)[1] === quoteId; }
  async acquireReplayLock(key: string, value: string, ttlSeconds: number) {
    return await this.command<string | null>(['SET', `gasless:replay:${key}`, value, 'NX', 'EX', ttlSeconds]) === 'OK';
  }
  async hasReplayLock(key: string) { return (await this.command<number>(['EXISTS', `gasless:replay:${key}`])) === 1; }
  async releaseReplayLockIfSafe(key: string, value: string) {
    const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    await this.command(['EVAL', script, 1, `gasless:replay:${key}`, value]);
  }
  async consumeRateLimit(key: string, limit: number, windowSeconds: number) {
    const script = "local n=redis.call('incr',KEYS[1]); if n==1 then redis.call('expire',KEYS[1],ARGV[1]) end; return n";
    return await this.command<number>(['EVAL', script, 1, `gasless:rate:${key}`, windowSeconds]) <= limit;
  }
  async reserveSponsorshipExposure(keys: string[], amount: number, limits: number[], windowSeconds: number, reservationId: string) {
    const namespaced = keys.map((key) => `gasless:sponsor:${key}`);
    const reservation = `gasless:sponsor-reservation:${reservationId}`;
    const script = "if redis.call('exists',KEYS[#KEYS])==1 then return 1 end; for i=1,#KEYS-1 do local n=tonumber(redis.call('get',KEYS[i]) or '0'); if n+tonumber(ARGV[1])>tonumber(ARGV[i+2]) then return 0 end end; for i=1,#KEYS-1 do redis.call('incrby',KEYS[i],ARGV[1]); if redis.call('ttl',KEYS[i])<0 then redis.call('expire',KEYS[i],ARGV[2]) end end; redis.call('set',KEYS[#KEYS],ARGV[1],'EX',ARGV[2]); return 1";
    return await this.command<number>(['EVAL', script, namespaced.length + 1, ...namespaced, reservation, amount, windowSeconds, ...limits]) === 1;
  }
  async releaseSponsorshipExposure(keys: string[], amount: number, reservationId: string) {
    const namespaced = keys.map((key) => `gasless:sponsor:${key}`); const reservation = `gasless:sponsor-reservation:${reservationId}`;
    const script = "if redis.call('exists',KEYS[#KEYS])==0 then return 0 end; if tonumber(redis.call('get',KEYS[#KEYS]))~=tonumber(ARGV[1]) then return -1 end; for i=1,#KEYS-1 do local n=tonumber(redis.call('get',KEYS[i]) or '-1'); if n<tonumber(ARGV[1]) then return -2 end end; for i=1,#KEYS-1 do local n=redis.call('decrby',KEYS[i],ARGV[1]); if n==0 then redis.call('del',KEYS[i]) end end; redis.call('del',KEYS[#KEYS]); return 1";
    const result = await this.command<number>(['EVAL', script, namespaced.length + 1, ...namespaced, reservation, amount]);
    if (result === 0) return 'already_released' as const;
    if (result !== 1) throw new GaslessError('CONFIGURATION_ERROR', 'sponsorship_release', result === -1 ? 'The sponsorship reservation amount does not match.' : 'The sponsorship counters cannot be safely released.');
    return 'released' as const;
  }
  async getSponsorshipExposure(key: string) { return Number(await this.command<string | null>(['GET', `gasless:sponsor:${key}`]) ?? 0); }
  async ping() { return await this.command<string>(['PING']) === 'PONG'; }
}
