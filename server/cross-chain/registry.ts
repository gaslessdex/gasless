import type { CrossChainInputAsset, CrossChainOutputAsset } from '../../shared/cross-chain/types.js';
import { GaslessError } from '../errors.js';

export const SOLANA_RELAY_CHAIN_ID = 792703809;
export const ROBINHOOD_CHAIN_ID = 4663;

export const CROSS_CHAIN_INPUTS: Record<CrossChainInputAsset, { address: string; decimals: number }> = {
  SOL: { address: '11111111111111111111111111111111', decimals: 9 },
  USDC: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDT: { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
};

export const CROSS_CHAIN_OUTPUTS: Record<CrossChainOutputAsset, { address: string; decimals: number }> = {
  ETH: { address: '0x0000000000000000000000000000000000000000', decimals: 18 },
  USDG: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 },
};

export function inputAsset(value: unknown): CrossChainInputAsset {
  if (typeof value !== 'string' || !(value in CROSS_CHAIN_INPUTS)) throw new GaslessError('TOKEN_UNSUPPORTED', 'cross_chain_registry', 'That source asset is not available for cross-chain transfers.');
  return value as CrossChainInputAsset;
}

export function outputAsset(value: unknown): CrossChainOutputAsset {
  if (typeof value !== 'string' || !(value in CROSS_CHAIN_OUTPUTS)) throw new GaslessError('TOKEN_UNSUPPORTED', 'cross_chain_registry', value === 'USDG' ? 'USDG is temporarily unavailable. Try ETH or check back shortly.' : 'That destination asset is not available for cross-chain transfers.');
  return value as CrossChainOutputAsset;
}

export function parseCrossChainAmount(value: string, decimals: number) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new GaslessError('INVALID_REQUEST', 'cross_chain_amount', 'Enter an amount greater than zero.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new GaslessError('INVALID_REQUEST', 'cross_chain_amount', `This asset supports up to ${decimals} decimal places.`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (raw <= 0n) throw new GaslessError('INVALID_REQUEST', 'cross_chain_amount', 'Enter an amount greater than zero.');
  return raw.toString();
}

export function normalizeRelayStatus(value?: string) { return value === 'success' ? 'completed' as const : value === 'submitted' ? 'destination_confirmed' as const : value === 'pending' ? 'executing' as const : value === 'depositing' ? 'source_confirmed' as const : value === 'failure' ? 'failed' as const : value === 'refund' ? 'refund_pending' as const : value === 'refunded' ? 'refunded' as const : value === 'waiting' ? 'awaiting_signature' as const : 'unknown_retryable' as const; }
