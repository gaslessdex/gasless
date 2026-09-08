export type ApiUsageCounter =
  | 'rpcRequests' | 'jupiterQuoteRequests' | 'jupiterBuildRequests' | 'jupiterPricingRequests'
  | 'tokenDiscoveryRequests' | 'cacheHits' | 'cacheMisses' | 'rateLimitedResponses'
  | 'failedRequests' | 'activeRequests' | 'idleRequests' | 'backgroundRequests'
  | 'transactionPreparations' | 'browserChallenges' | 'browserChallengeFailures';

const counters: Record<ApiUsageCounter, number> = {
  rpcRequests: 0, jupiterQuoteRequests: 0, jupiterBuildRequests: 0, jupiterPricingRequests: 0,
  tokenDiscoveryRequests: 0, cacheHits: 0, cacheMisses: 0, rateLimitedResponses: 0,
  failedRequests: 0, activeRequests: 0, idleRequests: 0, backgroundRequests: 0,
  transactionPreparations: 0, browserChallenges: 0, browserChallengeFailures: 0,
};

const startedAt = new Date().toISOString();

export function countApiUsage(counter: ApiUsageCounter, amount = 1) { counters[counter] += amount; }
export function apiUsageSnapshot() { return { scope: 'server-instance', startedAt, capturedAt: new Date().toISOString(), counters: { ...counters } }; }
export function countActivityHeader(value: string | string[] | undefined) {
  const state = Array.isArray(value) ? value[0] : value;
  countApiUsage(state === 'background' ? 'backgroundRequests' : state === 'idle' ? 'idleRequests' : 'activeRequests');
}
