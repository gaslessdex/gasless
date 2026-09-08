import type { SystemControls, TransactionAction } from '../../shared/transactions/types.js';
import { GaslessError } from '../errors.js';
import type { DurableStore } from '../storage/durable.js';

export class EmergencyControlService {
  constructor(private readonly store: DurableStore) {}
  async assertExecutionAllowed(action: TransactionAction, network: 'devnet' | 'mainnet-beta') {
    let controls: SystemControls;
    try { controls = await this.store.getControls(); }
    catch (error) { throw new GaslessError('ACTION_DISABLED', 'controls', 'GASLESS execution is paused while safety controls are unavailable.', true, undefined, { cause: error }); }
    if (!controls.globalExecutionEnabled) throw new GaslessError('ACTION_DISABLED', 'controls', controls.maintenanceMessage || 'GASLESS execution is temporarily paused.');
    if (!controls.relayerEnabled) throw new GaslessError('RELAYER_DISABLED', 'controls', 'GASLESS sponsorship is temporarily paused.');
    if (network === 'devnet' && !controls.devnetEnabled) throw new GaslessError('ACTION_DISABLED', 'controls', 'Devnet execution is disabled.');
    if (network === 'mainnet-beta' && !controls.mainnetEnabled) throw new GaslessError('ACTION_DISABLED', 'controls', 'Mainnet execution is disabled.');
    const enabled = action === 'DEVNET_PROOF' ? controls.proofEnabled : action === 'CLEAN_CLAIM' ? controls.cleanEnabled && controls.claimEnabled : action === 'CLEAN_RECOVER' ? controls.cleanEnabled && controls.recoverEnabled : action === 'CLEAN_BURN' ? controls.cleanEnabled && controls.burnEnabled : action.startsWith('CLEAN_') ? controls.cleanEnabled : action === 'SWAP' ? controls.swapEnabled : action === 'CROSS_CHAIN' ? controls.crossChainEnabled : controls.sendEnabled;
    if (!enabled) throw new GaslessError('ACTION_DISABLED', 'controls', action === 'CLEAN_CLAIM' ? 'Claim SOL is temporarily unavailable.' : action === 'SEND' ? 'Gasless Send is temporarily unavailable. Your tokens have not moved.' : 'This GASLESS action is temporarily disabled.');
    return controls;
  }
}
