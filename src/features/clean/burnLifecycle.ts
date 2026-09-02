import type { BurnDiscoveryResult } from '../../../shared/transactions/types.js';

export const BURN_SUCCESS_RESET_MS = 1_800;

export function discoveryReflectsBurnSettlement(discovery: BurnDiscoveryResult, closedAccount: string) {
  return discovery.accounts.every((account) => account.address !== closedAccount);
}
