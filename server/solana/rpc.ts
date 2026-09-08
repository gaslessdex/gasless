import { GaslessError } from '../errors.js';
import { AddressLookupTableAccount, AddressLookupTableProgram, PublicKey } from '@solana/web3.js';
import { log } from '../observability/logger.js';
import { requestWithBackoff } from '../network/retry.js';
import { countApiUsage } from '../observability/api-usage.js';

interface RpcEndpoint { url: string; name: 'helius' | 'fallback'; }
interface RpcResponse<T> { result?: T; error?: { code: number; message: string; data?: unknown }; }
export interface RpcSignatureStatus { slot: number; confirmations: number | null; err: unknown; confirmationStatus?: string }
export interface RpcProviderObservation<T> { provider: string; value?: T; errorCategory?: 'timeout' | 'rpc_error'; errorCode?: number }
export interface RpcBroadcastObservation { provider: string; category: 'accepted' | 'already_processed' | 'timeout' | 'rejected' | 'rpc_error'; returnedSignature?: string; errorCode?: number }
export interface RpcAccountInfo { lamports: number; owner: string; executable: boolean; rentEpoch: number; data: [string, string]; }
export interface RpcTransaction {
  slot: number;
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: RpcTokenBalance[]; postTokenBalances?: RpcTokenBalance[]; loadedAddresses?: { writable: string[]; readonly: string[] } };
  transaction: { message: { accountKeys: string[] } };
}
export interface RpcTokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
export interface RpcInnerInstruction {
  programIdIndex?: number;
  programId?: string;
  accounts?: number[] | string[];
  data?: string;
  stackHeight?: number | null;
  parsed?: { type?: string; info?: Record<string, unknown> };
}
export interface RpcInnerInstructionGroup { index: number; instructions: RpcInnerInstruction[] }

export class SolanaRpc {
  private readonly endpoints: RpcEndpoint[];
  private readonly verifiedEndpoints = new Set<string>();
  private static readonly DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  private static readonly MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  constructor(primaryUrl: string, fallbackUrl?: string, private readonly network: 'devnet' | 'mainnet-beta' = 'devnet', private readonly request: typeof fetch = fetch) {
    this.endpoints = [{ url: primaryUrl, name: 'helius' }, ...(fallbackUrl ? [{ url: fallbackUrl, name: 'fallback' as const }] : [])];
  }

  private async assertNetwork(endpoint: RpcEndpoint) {
    if (this.verifiedEndpoints.has(endpoint.url)) return;
    const response = await this.request(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'getGenesisHash' }), signal: AbortSignal.timeout(5_000) });
    const payload = await response.json() as RpcResponse<string>;
    if (!response.ok || payload.error || !payload.result) throw new Error('RPC network identity could not be established');
    const expected = this.network === 'mainnet-beta' ? SolanaRpc.MAINNET_GENESIS_HASH : SolanaRpc.DEVNET_GENESIS_HASH;
    if (payload.result !== expected) throw new GaslessError('UNSUPPORTED_NETWORK', 'rpc_network_guard', `A configured Solana RPC endpoint is not ${this.network === 'mainnet-beta' ? 'Mainnet' : 'Devnet'}.`);
    this.verifiedEndpoints.add(endpoint.url);
  }

  async assertNetworkIdentity() { for (const endpoint of this.endpoints) await this.assertNetwork(endpoint); }

  private async call<T>(method: string, params: unknown[], allowFallback = true): Promise<{ value: T; provider: string }> {
    let lastError: unknown;
    for (const endpoint of allowFallback ? this.endpoints : this.endpoints.slice(0, 1)) {
      try {
        await this.assertNetwork(endpoint);
        const response = await requestWithBackoff(() => { countApiUsage('rpcRequests'); return this.request(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }), signal: AbortSignal.timeout(10_000) }); }, { onRetry: (status, delayMs) => { if (status === 429) countApiUsage('rateLimitedResponses'); log('warn', 'rpc_retry_scheduled', { provider: endpoint.name, method, status, delayMs }); } });
        const payload = await response.json() as RpcResponse<T>;
        if (!response.ok || payload.error || payload.result === undefined) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
        return { value: payload.result, provider: endpoint.name };
      } catch (error) {
        if (error instanceof GaslessError && error.code === 'UNSUPPORTED_NETWORK') throw error;
        lastError = error;
        log('warn', 'rpc_call_failed', { provider: endpoint.name, method, error: error instanceof Error ? error.message : String(error) });
      }
    }
    throw new GaslessError('RPC_ERROR', 'rpc', `Solana ${this.network === 'mainnet-beta' ? 'Mainnet' : 'Devnet'} is temporarily unavailable.`, true, undefined, { cause: lastError });
  }

  async getLatestBlockhash() { return this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]).then(({ value, provider }) => ({ ...value.value, provider })); }
  async getBlockHeight() { return this.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]).then((result) => result.value); }
  async getBlockTime(slot: number) { return this.call<number | null>('getBlockTime', [slot]).then((result) => result.value); }
  async isBlockhashValid(blockhash: string) { return this.call<{ value: boolean }>('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]).then(({ value }) => value.value); }
  async getFeeForMessage(serializedMessage: string) { return this.call<{ value: number | null }>('getFeeForMessage', [serializedMessage, { commitment: 'confirmed' }]).then(({ value }) => value.value); }
  async simulateTransaction(serialized: string, sigVerify: boolean) {
    return this.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; innerInstructions?: RpcInnerInstructionGroup[] | null } }>('simulateTransaction', [serialized, { encoding: 'base64', commitment: 'confirmed', sigVerify, replaceRecentBlockhash: false, innerInstructions: true }]).then(({ value, provider }) => ({ ...value.value, provider }));
  }
  async simulateTransactionWithAccounts(serialized: string, sigVerify: boolean, addresses: string[]) {
    return this.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number; innerInstructions?: RpcInnerInstructionGroup[] | null; accounts?: Array<RpcAccountInfo | null> } }>('simulateTransaction', [serialized, { encoding: 'base64', commitment: 'confirmed', sigVerify, replaceRecentBlockhash: false, innerInstructions: true, accounts: { encoding: 'base64', addresses } }]).then(({ value, provider }) => ({ ...value.value, provider }));
  }
  async sendRawTransaction(serialized: string) {
    // Never blind-retry submission across providers. Reconciliation owns ambiguous outcomes.
    return this.call<string>('sendTransaction', [serialized, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }], false).then(({ value, provider }) => ({ signature: value, provider }));
  }
  async broadcastRawTransactionAcrossProviders(serialized: string): Promise<RpcBroadcastObservation[]> {
    return Promise.all(this.endpoints.map(async (endpoint) => {
      try {
        await this.assertNetwork(endpoint);
        const response = await this.request(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'sendTransaction', params: [serialized, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }] }), signal: AbortSignal.timeout(10_000) });
        const payload = await response.json() as RpcResponse<string>;
        if (response.ok && payload.result) return { provider: endpoint.name, category: 'accepted' as const, returnedSignature: payload.result };
        const message = payload.error?.message?.toLowerCase() ?? '';
        if (message.includes('already processed') || message.includes('already been processed')) return { provider: endpoint.name, category: 'already_processed' as const, errorCode: payload.error?.code };
        return { provider: endpoint.name, category: response.ok ? 'rejected' as const : 'rpc_error' as const, errorCode: payload.error?.code ?? response.status };
      } catch (error) {
        if (error instanceof GaslessError && error.code === 'UNSUPPORTED_NETWORK') throw error;
        const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return { provider: endpoint.name, category: timeout ? 'timeout' as const : 'rpc_error' as const };
      }
    }));
  }
  async getSignatureStatuses(signature: string) {
    return this.call<{ value: Array<RpcSignatureStatus | null> }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]).then(({ value }) => value.value[0]);
  }
  async getSignatureStatusesAcrossProviders(signature: string): Promise<Array<RpcProviderObservation<RpcSignatureStatus | null>>> {
    return Promise.all(this.endpoints.map(async (endpoint) => {
      try {
        await this.assertNetwork(endpoint);
        const response = await this.request(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'getSignatureStatuses', params: [[signature], { searchTransactionHistory: true }] }), signal: AbortSignal.timeout(10_000) });
        const payload = await response.json() as RpcResponse<{ value: Array<RpcSignatureStatus | null> }>;
        if (!response.ok || payload.error || !payload.result) return { provider: endpoint.name, errorCategory: 'rpc_error' as const, errorCode: payload.error?.code ?? response.status };
        return { provider: endpoint.name, value: payload.result.value[0] ?? null };
      } catch (error) {
        if (error instanceof GaslessError && error.code === 'UNSUPPORTED_NETWORK') throw error;
        const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return { provider: endpoint.name, errorCategory: timeout ? 'timeout' as const : 'rpc_error' as const };
      }
    }));
  }
  async getBlockHeightsAcrossProviders(): Promise<Array<RpcProviderObservation<number>>> {
    return Promise.all(this.endpoints.map(async (endpoint) => {
      try {
        await this.assertNetwork(endpoint);
        const response = await this.request(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'getBlockHeight', params: [{ commitment: 'confirmed' }] }), signal: AbortSignal.timeout(10_000) });
        const payload = await response.json() as RpcResponse<number>;
        if (!response.ok || payload.error || payload.result === undefined) return { provider: endpoint.name, errorCategory: 'rpc_error' as const, errorCode: payload.error?.code ?? response.status };
        return { provider: endpoint.name, value: payload.result };
      } catch (error) {
        if (error instanceof GaslessError && error.code === 'UNSUPPORTED_NETWORK') throw error;
        const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return { provider: endpoint.name, errorCategory: timeout ? 'timeout' as const : 'rpc_error' as const };
      }
    }));
  }
  async getTransaction(signature: string) {
    return this.call<RpcTransaction | null>('getTransaction', [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }]).then(({ value }) => {
      if (value?.meta.loadedAddresses) value.transaction.message.accountKeys.push(...value.meta.loadedAddresses.writable, ...value.meta.loadedAddresses.readonly);
      return value;
    });
  }
  async getTransactionAcrossProviders(signature: string): Promise<RpcTransaction | null> {
    const results = await Promise.all(this.endpoints.map(async (endpoint) => {
      try {
        await this.assertNetwork(endpoint);
        const response = await this.request(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'getTransaction', params: [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }] }), signal: AbortSignal.timeout(10_000) });
        const payload = await response.json() as RpcResponse<RpcTransaction | null>;
        if (!response.ok || payload.error || payload.result === undefined) return null;
        return payload.result;
      } catch { return null; }
    }));
    const value = results.find((result): result is RpcTransaction => result !== null) ?? null;
    if (value?.meta.loadedAddresses) value.transaction.message.accountKeys.push(...value.meta.loadedAddresses.writable, ...value.meta.loadedAddresses.readonly);
    return value;
  }
  async getBalance(address: string) { return this.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]).then(({ value }) => value.value); }
  async getMinimumBalanceForRentExemption(dataLength: number) { return this.call<number>('getMinimumBalanceForRentExemption', [dataLength, { commitment: 'confirmed' }]).then(({ value }) => value); }
  async getAccountInfo(address: string) { return this.call<{ value: RpcAccountInfo | null }>('getAccountInfo', [address, { commitment: 'confirmed', encoding: 'base64' }]).then(({ value }) => value.value); }
  async getAddressLookupTable(address: string) {
    const account = await this.getAccountInfo(address);
    if (!account || account.owner !== AddressLookupTableProgram.programId.toBase58() || account.executable || account.data[1] !== 'base64') return null;
    try { return new AddressLookupTableAccount({ key: new PublicKey(address), state: AddressLookupTableAccount.deserialize(Buffer.from(account.data[0], 'base64')) }); }
    catch { return null; }
  }
  async getMultipleAccounts(addresses: string[]) { return this.call<{ value: Array<RpcAccountInfo | null> }>('getMultipleAccounts', [addresses, { commitment: 'confirmed', encoding: 'base64' }]).then(({ value }) => value.value); }
  async getTokenAccountsByOwner(owner: string, programId: string) {
    return this.call<{ value: Array<{ pubkey: string; account: RpcAccountInfo }> }>('getTokenAccountsByOwner', [owner, { programId }, { commitment: 'confirmed', encoding: 'base64' }]).then(({ value }) => value.value);
  }
}
