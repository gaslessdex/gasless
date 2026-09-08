export function retryDelayMs(attempt: number, retryAfter: string | null, random = Math.random, now = Date.now()) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, Math.ceil(seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(10_000, Math.max(0, date - now));
  }
  return Math.min(4_000, 250 * 2 ** attempt) + Math.floor(random() * 151);
}

export async function requestWithBackoff(call: () => Promise<Response>, options: { attempts?: number; sleep?: (milliseconds: number) => Promise<void>; random?: () => number; onRetry?: (status: number | 'network', delayMs: number) => void } = {}) {
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 2));
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await call();
      if (attempt === attempts - 1 || (response.status !== 429 && response.status < 500)) return response;
      const delay = retryDelayMs(attempt, response.headers.get('retry-after'), options.random);
      options.onRetry?.(response.status, delay); await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
      const delay = retryDelayMs(attempt, null, options.random);
      options.onRetry?.('network', delay); await sleep(delay);
    }
  }
  throw lastError;
}
