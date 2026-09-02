import type { ClaimDiscoveryResult } from '../../../shared/transactions/types.js';

export function discoveryReflectsClaimSettlement(discovery: ClaimDiscoveryResult, closedAccounts: string[]) {
  const currentAccounts = new Set(discovery.accounts.map((account) => account.address));
  return closedAccounts.every((address) => !currentAccounts.has(address));
}

export function nonemptySkippedAccountCount(discovery?: ClaimDiscoveryResult) {
  return discovery?.skippedAccounts.filter((account) => BigInt(account.tokenAmountRaw) > 0n).length ?? 0;
}
