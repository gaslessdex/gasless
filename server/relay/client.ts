import { GaslessError } from '../errors.js';
import type { RelayProtocolOrder } from '../../chains/solana/relay/order.js';
import type { RelayTransactionData } from '../../chains/solana/relay/validator.js';

export interface RelayQuoteResponse {
  requestId?: string;
  steps?: Array<{ requestId?: string; kind?: string; items?: Array<{ data?: RelayTransactionData; check?: { endpoint?: string } }> }>;
  fees?: Record<string, { amount?: string; amountFormatted?: string; amountUsd?: string; currency?: { symbol?: string } }>;
  details?: { sender?: string; recipient?: string; currencyIn?: RelayAmount; currencyOut?: RelayAmount; timeEstimate?: number };
  protocol?: { v2?: { orderId?: string; orderData?: RelayProtocolOrder; paymentDetails?: { chainId?: string; depository?: string; currency?: string; amount?: string } } };
}
interface RelayAmount { amount?: string; amountFormatted?: string; amountUsd?: string; minimumAmount?: string; currency?: { chainId?: number; address?: string; symbol?: string; decimals?: number } }

export class RelayClient {
  constructor(private readonly apiKey?: string, private readonly request: typeof fetch = fetch) {}

  async quote(payload: Record<string, unknown>) {
    if (!this.apiKey) throw new GaslessError('CONFIGURATION_ERROR', 'relay', 'Cross-chain quoting is not configured.');
    return this.call<RelayQuoteResponse>('/quote/v2', { method: 'POST', body: JSON.stringify(payload) }, true);
  }

  async status(requestId: string) {
    return this.call<{ status?: string; originChainId?: number; destinationChainId?: number }>(`/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, { method: 'GET' }, true);
  }

  private async call<T>(path: string, init: RequestInit, retryable: boolean): Promise<T> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < (retryable ? 2 : 1); attempt += 1) {
      try {
        const response = await this.request(`https://api.relay.link${path}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey! }, signal: AbortSignal.timeout(10_000) });
        lastStatus = response.status;
        const value = await response.json() as T & { errorCode?: string; message?: string };
        if (response.ok) return value;
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
        throw relayError(response.status, value.errorCode, value.message);
      } catch (error) {
        if (error instanceof GaslessError) throw error;
        if (attempt === 0) continue;
        throw new GaslessError('RELAY_UNAVAILABLE', 'relay', 'Relay is temporarily unavailable. Try again shortly.', true, undefined, { cause: error });
      }
    }
    throw relayError(lastStatus);
  }
}

function relayError(status: number, code?: string, message?: string) {
  if (code === 'AMOUNT_TOO_LOW') return new GaslessError('INVALID_REQUEST', 'relay_quote', 'This amount is too small for the current route.');
  if (code === 'AMOUNT_TOO_HIGH') return new GaslessError('INVALID_REQUEST', 'relay_quote', 'This amount is above the current cross-chain limit.');
  if (status === 429) return new GaslessError('RATE_LIMITED', 'relay_quote', 'Cross-chain quotes are busy. Please wait a moment and try again.', true);
  if (/no route|unsupported|not supported/i.test(message ?? '')) return new GaslessError('TOKEN_UNSUPPORTED', 'relay_quote', 'This cross-chain route is temporarily unavailable.');
  return new GaslessError('RELAY_UNAVAILABLE', 'relay_quote', 'Relay is temporarily unavailable. Try again shortly.', status >= 500);
}
