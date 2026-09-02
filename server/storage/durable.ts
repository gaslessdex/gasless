import type { DurableTransactionRecord, ReconciliationResult, SolanaNetwork, SystemControls, TransactionIntent } from '../../shared/transactions/types.js';
import { GaslessError } from '../errors.js';

export const DEVNET_CONTROLS: SystemControls = {
  globalExecutionEnabled: true,
  relayerEnabled: true,
  devnetEnabled: true,
  mainnetEnabled: false,
  cleanEnabled: true,
  swapEnabled: true,
  sendEnabled: true,
  proofEnabled: true,
  claimEnabled: true,
  burnEnabled: true,
  recoverEnabled: true,
};

export interface DurableStore {
  createIntent(intent: TransactionIntent, quoteId: string): Promise<void>;
  updateIntentStatus(intentId: string, status: string): Promise<void>;
  createTransaction(record: DurableTransactionRecord): Promise<void>;
  updateTransaction(id: string, patch: Partial<DurableTransactionRecord>): Promise<void>;
  getTransaction(id: string): Promise<DurableTransactionRecord | null>;
  getTransactionByQuoteId(quoteId: string): Promise<DurableTransactionRecord | null>;
  appendEvent(transactionId: string, eventType: string, stage: string, metadata?: Record<string, unknown>, idempotencyKey?: string): Promise<void>;
  recordReconciliation(result: ReconciliationResult, walletAddress: string): Promise<void>;
  recordClaimAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string): Promise<void>;
  recordBurnAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string): Promise<void>;
  recordRecoverAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string, actualUserPayoutLamports: string): Promise<void>;
  recordSendAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string): Promise<void>;
  recordSwapAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string, actualOutputRaw: string): Promise<void>;
  getControls(): Promise<SystemControls>;
  setControl(key: string, enabled: boolean): Promise<void>;
  getOperatorMetrics(network?: SolanaNetwork): Promise<ReturnType<typeof summarizeTransactions>>;
}

export class MemoryDurableStore implements DurableStore {
  readonly intents = new Map<string, string>();
  readonly transactions = new Map<string, DurableTransactionRecord>();
  readonly events = new Map<string, unknown>();
  controls = { ...DEVNET_CONTROLS };
  async createIntent(intent: TransactionIntent) { this.intents.set(intent.intentId, 'created'); }
  async updateIntentStatus(intentId: string, status: string) { this.intents.set(intentId, status); }
  async createTransaction(record: DurableTransactionRecord) { this.transactions.set(record.id, structuredClone(record)); }
  async updateTransaction(id: string, patch: Partial<DurableTransactionRecord>) {
    const current = this.transactions.get(id);
    if (!current) throw new GaslessError('DATABASE_ERROR', 'database', 'Transaction record was not found.');
    this.transactions.set(id, { ...current, ...patch });
  }
  async getTransaction(id: string) { return this.transactions.get(id) ?? null; }
  async getTransactionByQuoteId(quoteId: string) { return [...this.transactions.values()].find((record) => record.quoteId === quoteId) ?? null; }
  async appendEvent(transactionId: string, eventType: string, stage: string, metadata: Record<string, unknown> = {}, idempotencyKey: string = crypto.randomUUID()) {
    if (!this.events.has(idempotencyKey)) this.events.set(idempotencyKey, { transactionId, eventType, stage, metadata });
  }
  async recordReconciliation(result: ReconciliationResult, walletAddress: string) {
    if (result.status === 'pending') return;
    const key = `${result.transactionId}:reconciled`;
    await this.appendEvent(result.transactionId, result.status === 'confirmed' ? 'proof_succeeded' : 'proof_failed', 'reconciled', { status: result.status, walletAddress }, key);
    if (result.networkFeeLamports) await this.appendEvent(result.transactionId, 'network_fee_sponsored', 'accounting', { amountRaw: result.networkFeeLamports }, `${result.transactionId}:network_fee`);
  }
  async recordClaimAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string) {
    const metadata = { walletAddress: record.walletAddress, accountCount: record.accountAddresses?.length ?? 0, grossRecoveredLamports: record.grossRecoveredLamports, gaslessFeeLamports: record.gaslessFeeLamports, sponsoredCostLamports: actualNetworkFeeLamports, netUserLamports: record.netUserLamports };
    await this.appendEvent(record.id, 'claim_succeeded', 'accounting', metadata, `${record.id}:claim_accounting`);
  }
  async recordBurnAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string) { await this.appendEvent(record.id, 'burn_succeeded', 'accounting', { walletAddress: record.walletAddress, mint: record.mint, tokenAccount: record.tokenAccount, tokenAmountRaw: record.tokenAmountRaw, decimals: record.tokenDecimals, reclaimedRentLamports: record.grossRecoveredLamports, gaslessFeeLamports: record.gaslessFeeLamports, sponsoredCostLamports: actualNetworkFeeLamports, netUserLamports: record.netUserLamports }, `${record.id}:burn_accounting`); }
  async recordRecoverAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string, actualUserPayoutLamports: string) { await this.appendEvent(record.id, 'recover_succeeded', 'accounting', { walletAddress: record.walletAddress, mint: record.mint, tokenAccount: record.tokenAccount, tokenAmountRaw: record.tokenAmountRaw, estimatedSwapOutputLamports: record.estimatedSwapOutputLamports, minimumSwapOutputLamports: record.minimumSwapOutputLamports, swapServiceFeeLamports: record.swapServiceFeeLamports, rentServiceFeeLamports: record.rentServiceFeeLamports, sponsoredCostLamports: actualNetworkFeeLamports, actualUserPayoutLamports }, `${record.id}:recover_accounting`); }
  async recordSendAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string) { await this.appendEvent(record.id, 'send_succeeded', 'accounting', { walletAddress: record.walletAddress, recipientWallet: record.recipientWallet, mint: record.mint, recipientAmountRaw: record.recipientAmountRaw, sponsorReimbursementRaw: record.sponsorReimbursementRaw, serviceFeeRaw: record.serviceFeeRaw, totalDebitRaw: record.totalDebitRaw, recipientAtaCreated: record.recipientAtaCreated, ataCreationLamports: record.ataCreationLamports, actualNetworkFeeLamports }, `${record.id}:send_accounting`); }
  async recordSwapAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string, actualOutputRaw: string) { await this.appendEvent(record.id, 'swap_succeeded', 'accounting', { walletAddress: record.walletAddress, inputMint: record.inputMint, outputMint: record.outputMint, totalInputRaw: record.tokenAmountRaw, routedInputRaw: record.routedInputRaw, minimumOutputRaw: record.minimumOutputRaw, actualOutputRaw, serviceFeeRaw: record.serviceFeeRaw, sponsorReimbursementRaw: record.sponsorReimbursementRaw, actualNetworkFeeLamports, outputAtaRentLamports: record.outputAtaRentLamports }, `${record.id}:swap_accounting`); }
  async getControls() { return { ...this.controls }; }
  async setControl(key: string, enabled: boolean) {
    const map: Record<string, keyof SystemControls> = { global_execution: 'globalExecutionEnabled', relayer: 'relayerEnabled', devnet: 'devnetEnabled', mainnet: 'mainnetEnabled', clean: 'cleanEnabled', claim: 'claimEnabled', recover: 'recoverEnabled', burn: 'burnEnabled', swap: 'swapEnabled', send: 'sendEnabled', devnet_proof: 'proofEnabled' };
    if (!map[key]) throw new GaslessError('INVALID_REQUEST', 'controls', 'Unknown safety control.');
    (this.controls[map[key]] as boolean) = enabled;
  }
  async getOperatorMetrics(network?: SolanaNetwork) { return summarizeTransactions([...this.transactions.values()].filter((record) => !network || record.network === network)); }
}

type SupabaseRow = Record<string, unknown>;

export class SupabaseDurableStore implements DurableStore {
  constructor(private readonly url: string, private readonly key: string) {}

  private async request(path: string, method = 'GET', body?: unknown, prefer?: string) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      method,
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) throw new GaslessError('DATABASE_ERROR', 'database', 'Durable transaction storage is unavailable.', true);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async createIntent(intent: TransactionIntent, quoteId: string) {
    await this.request('transaction_intents', 'POST', { id: intent.intentId, wallet_address: intent.walletAddress, action_type: intent.actionType, network: intent.network, client_request_id: intent.clientRequestId, request_id: intent.requestId, status: 'created', quote_id: quoteId, expires_at: intent.expiresAt }, 'return=minimal');
  }
  async updateIntentStatus(intentId: string, status: string) {
    await this.request(`transaction_intents?id=eq.${encodeURIComponent(intentId)}`, 'PATCH', { status, updated_at: new Date().toISOString() }, 'return=minimal');
  }
  async createTransaction(record: DurableTransactionRecord) {
    await this.request('transactions', 'POST', this.toRow(record), 'return=minimal');
  }
  async updateTransaction(id: string, patch: Partial<DurableTransactionRecord>) {
    await this.request(`transactions?id=eq.${encodeURIComponent(id)}`, 'PATCH', this.toRow(patch), 'return=minimal');
  }
  async getTransaction(id: string) {
    const rows = await this.request(`transactions?id=eq.${encodeURIComponent(id)}&limit=1`) as SupabaseRow[];
    if (!rows[0]) return null;
    const record = this.fromRow(rows[0]);
    Object.assign(record, {
      inputMint: rows[0].input_mint as string | undefined,
      outputMint: rows[0].output_mint as string | undefined,
      outputTokenDecimals: rows[0].output_token_decimals as number | undefined,
      routedInputRaw: rows[0].routed_input_raw as string | undefined,
      expectedOutputRaw: rows[0].expected_output_raw as string | undefined,
      minimumOutputRaw: rows[0].minimum_output_raw as string | undefined,
      actualOutputRaw: rows[0].actual_output_raw as string | undefined,
      outputAccount: rows[0].output_account as string | undefined,
      outputAtaCreated: rows[0].output_ata_created as boolean | undefined,
      outputAtaRentLamports: rows[0].output_ata_rent_lamports as string | undefined,
      slippageBps: rows[0].slippage_bps as number | undefined,
      priceImpactBps: rows[0].price_impact_bps as number | undefined,
      routeFingerprint: rows[0].route_fingerprint as string | undefined,
    });
    return record;
  }
  async getTransactionByQuoteId(quoteId: string) {
    const rows = await this.request(`transactions?quote_id=eq.${encodeURIComponent(quoteId)}&limit=1`) as SupabaseRow[];
    return rows[0] ? this.fromRow(rows[0]) : null;
  }
  async appendEvent(transactionId: string, eventType: string, stage: string, metadata: Record<string, unknown> = {}, idempotencyKey: string = crypto.randomUUID()) {
    await this.request('transaction_events?on_conflict=idempotency_key', 'POST', { transaction_id: transactionId, event_type: eventType, stage, metadata, idempotency_key: idempotencyKey }, 'resolution=ignore-duplicates,return=minimal');
  }
  async recordReconciliation(result: ReconciliationResult, walletAddress: string) {
    if (result.status === 'pending') return;
    await this.appendEvent(result.transactionId, result.status === 'confirmed' ? 'proof_succeeded' : 'proof_failed', 'reconciled', { status: result.status, walletAddress }, `${result.transactionId}:reconciled`);
    if (result.networkFeeLamports) {
      await this.request('accounting_entries?on_conflict=transaction_id,entry_type', 'POST', { transaction_id: result.transactionId, entry_type: 'network_fee_paid', asset: 'SOL', amount_raw: result.networkFeeLamports, decimals: 9, amount_display: Number(result.networkFeeLamports) / 1e9 }, 'resolution=ignore-duplicates,return=minimal');
    }
  }
  async recordClaimAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string) {
    const entries = [
      ['gross_recovered', record.grossRecoveredLamports],
      ['gasless_service_fee', record.gaslessFeeLamports],
      ['network_fee_paid', actualNetworkFeeLamports],
      ['net_user_payout', record.netUserLamports],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])).map(([entry_type, amount_raw]) => ({ transaction_id: record.id, entry_type, asset: 'SOL', amount_raw, decimals: 9 }));
    await this.request('accounting_entries?on_conflict=transaction_id,entry_type', 'POST', entries, 'resolution=ignore-duplicates,return=minimal');
    await this.appendEvent(record.id, 'claim_succeeded', 'accounting', { walletAddress: record.walletAddress, accountCount: record.accountAddresses?.length ?? 0 }, `${record.id}:claim_accounting`);
  }
  async recordBurnAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string) {
    const entries = [
      { entry_type: 'token_burned', asset: 'SPL', mint: record.mint, amount_raw: record.tokenAmountRaw, decimals: record.tokenDecimals },
      { entry_type: 'gross_recovered', asset: 'SOL', amount_raw: record.grossRecoveredLamports, decimals: 9 },
      { entry_type: 'gasless_service_fee', asset: 'SOL', amount_raw: record.gaslessFeeLamports, decimals: 9 },
      { entry_type: 'network_fee_paid', asset: 'SOL', amount_raw: actualNetworkFeeLamports, decimals: 9 },
      { entry_type: 'net_user_payout', asset: 'SOL', amount_raw: record.netUserLamports, decimals: 9 },
    ].filter((entry) => entry.amount_raw !== undefined);
    await this.request('accounting_entries?on_conflict=transaction_id,entry_type', 'POST', entries.map((entry) => ({ transaction_id: record.id, mint: null, ...entry })), 'resolution=ignore-duplicates,return=minimal');
    await this.appendEvent(record.id, 'burn_succeeded', 'accounting', { walletAddress: record.walletAddress, mint: record.mint, tokenAccount: record.tokenAccount }, `${record.id}:burn_accounting`);
  }
  async recordRecoverAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string, actualUserPayoutLamports: string) {
    const entries = [
      { entry_type: 'token_swapped', asset: 'SPL', mint: record.mint, amount_raw: record.tokenAmountRaw, decimals: record.tokenDecimals },
      { entry_type: 'minimum_swap_output', asset: 'SOL', amount_raw: record.minimumSwapOutputLamports, decimals: 9 },
      { entry_type: 'rent_recovered', asset: 'SOL', amount_raw: record.grossRecoveredLamports, decimals: 9 },
      { entry_type: 'recover_swap_service_fee', asset: 'SOL', amount_raw: record.swapServiceFeeLamports, decimals: 9 },
      { entry_type: 'recover_rent_service_fee', asset: 'SOL', amount_raw: record.rentServiceFeeLamports, decimals: 9 },
      { entry_type: 'temporary_account_rent_sponsored', asset: 'SOL', amount_raw: record.temporaryAccountRentLamports, decimals: 9 },
      { entry_type: 'network_fee_paid', asset: 'SOL', amount_raw: actualNetworkFeeLamports, decimals: 9 },
      { entry_type: 'net_user_payout', asset: 'SOL', amount_raw: actualUserPayoutLamports, decimals: 9 },
    ].filter((entry) => entry.amount_raw !== undefined);
    await this.request('accounting_entries?on_conflict=transaction_id,entry_type', 'POST', entries.map((entry) => ({ transaction_id: record.id, mint: null, ...entry })), 'resolution=ignore-duplicates,return=minimal');
    await this.appendEvent(record.id, 'recover_succeeded', 'accounting', { walletAddress: record.walletAddress, mint: record.mint, tokenAccount: record.tokenAccount }, `${record.id}:recover_accounting`);
  }
  async recordSendAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string) {
    const entries: Array<Record<string, unknown>> = [
      { entry_type: 'send_recipient_amount', amount_raw: record.recipientAmountRaw },
      { entry_type: 'sponsor_reimbursement', amount_raw: record.sponsorReimbursementRaw },
      { entry_type: 'send_service_fee', amount_raw: record.serviceFeeRaw },
      { entry_type: 'send_total_debit', amount_raw: record.totalDebitRaw },
    ].filter((entry) => entry.amount_raw !== undefined).map((entry) => ({ transaction_id: record.id, asset: 'SPL', mint: record.mint, decimals: record.tokenDecimals, ...entry }));
    entries.push({ transaction_id: record.id, entry_type: 'network_fee_paid', asset: 'SOL', mint: null, amount_raw: actualNetworkFeeLamports, decimals: 9 });
    if (record.recipientAtaCreated && record.ataCreationLamports) entries.push({ transaction_id: record.id, entry_type: 'recipient_ata_rent_sponsored', asset: 'SOL', mint: null, amount_raw: record.ataCreationLamports, decimals: 9 });
    await this.request('accounting_entries?on_conflict=transaction_id,entry_type', 'POST', entries, 'resolution=ignore-duplicates,return=minimal');
    await this.appendEvent(record.id, 'send_succeeded', 'accounting', { walletAddress: record.walletAddress, mint: record.mint, recipientAtaCreated: record.recipientAtaCreated }, `${record.id}:send_accounting`);
  }
  async recordSwapAccounting(record: DurableTransactionRecord, actualNetworkFeeLamports: string, actualOutputRaw: string) {
    const input = { asset: 'SPL', mint: record.inputMint, decimals: record.tokenDecimals };
    const outputDecimals = record.outputTokenDecimals ?? 0;
    const entries = [
      { entry_type: 'swap_total_input', amount_raw: record.tokenAmountRaw, ...input },
      { entry_type: 'swap_routed_input', amount_raw: record.routedInputRaw, ...input },
      { entry_type: 'swap_service_fee', amount_raw: record.serviceFeeRaw, ...input },
      { entry_type: 'sponsor_reimbursement', amount_raw: record.sponsorReimbursementRaw, ...input },
      { entry_type: 'swap_actual_output', amount_raw: actualOutputRaw, asset: 'SPL', mint: record.outputMint, decimals: outputDecimals },
      { entry_type: 'network_fee_paid', amount_raw: actualNetworkFeeLamports, asset: 'SOL', mint: null, decimals: 9 },
      ...(record.outputAtaCreated && record.outputAtaRentLamports ? [{ entry_type: 'output_ata_rent_sponsored', amount_raw: record.outputAtaRentLamports, asset: 'SOL', mint: null, decimals: 9 }] : []),
    ].filter((entry) => entry.amount_raw !== undefined).map((entry) => ({ transaction_id: record.id, ...entry }));
    await this.request('accounting_entries?on_conflict=transaction_id,entry_type', 'POST', entries, 'resolution=ignore-duplicates,return=minimal');
    await this.appendEvent(record.id, 'swap_succeeded', 'accounting', { walletAddress: record.walletAddress, inputMint: record.inputMint, outputMint: record.outputMint }, `${record.id}:swap_accounting`);
  }
  async getControls() {
    const rows = await this.request('system_controls?select=control_key,enabled,text_value') as Array<{ control_key: string; enabled: boolean; text_value?: string }>;
    const values = new Map(rows.map((row) => [row.control_key, row]));
    const required = ['global_execution', 'relayer', 'devnet', 'mainnet', 'clean', 'claim', 'recover', 'burn', 'swap', 'send', 'devnet_proof'];
    if (required.some((key) => !values.has(key))) throw new GaslessError('CONFIGURATION_ERROR', 'controls', 'Safety controls are unavailable.');
    return {
      globalExecutionEnabled: values.get('global_execution')!.enabled,
      relayerEnabled: values.get('relayer')!.enabled,
      devnetEnabled: values.get('devnet')!.enabled,
      mainnetEnabled: values.get('mainnet')!.enabled,
      cleanEnabled: values.get('clean')!.enabled,
      swapEnabled: values.get('swap')!.enabled,
      sendEnabled: values.get('send')!.enabled,
      proofEnabled: values.get('devnet_proof')!.enabled,
      claimEnabled: values.get('claim')!.enabled,
      recoverEnabled: values.get('recover')!.enabled,
      burnEnabled: values.get('burn')!.enabled,
      maintenanceMessage: values.get('global_execution')?.text_value,
    };
  }
  async setControl(key: string, enabled: boolean) {
    const allowed = new Set(['global_execution', 'relayer', 'devnet', 'mainnet', 'clean', 'claim', 'recover', 'burn', 'swap', 'send', 'devnet_proof']);
    if (!allowed.has(key)) throw new GaslessError('INVALID_REQUEST', 'controls', 'Unknown safety control.');
    await this.request(`system_controls?control_key=eq.${encodeURIComponent(key)}`, 'PATCH', { enabled, updated_at: new Date().toISOString() }, 'return=minimal');
  }
  async getOperatorMetrics(network?: SolanaNetwork) {
    const filter = network ? `&network=eq.${encodeURIComponent(network)}` : '';
    const rows = await this.request(`transactions?select=id,quote_id,wallet_address,action_type,network,status,signature,sponsored_cost_lamports,gasless_fee_lamports,swap_service_fee_lamports,rent_service_fee_lamports,sponsor_reimbursement_raw,service_fee_raw,mint,input_mint,output_mint,token_amount_raw,expected_output_raw,actual_output_raw,minimum_output_raw,ata_creation_lamports,output_ata_rent_lamports,error_code,error_stage,updated_at${filter}&order=updated_at.desc&limit=1000`) as SupabaseRow[];
    return summarizeTransactions(rows.map((row) => ({ id: String(row.id), intentId: '', quoteId: String(row.quote_id), walletAddress: String(row.wallet_address), actionType: row.action_type as DurableTransactionRecord['actionType'], network: row.network as SolanaNetwork, status: row.status as DurableTransactionRecord['status'], signature: row.signature as string | undefined, sponsoredCostLamports: row.sponsored_cost_lamports as string | undefined, gaslessFeeLamports: row.gasless_fee_lamports as string | undefined, swapServiceFeeLamports: row.swap_service_fee_lamports as string | undefined, rentServiceFeeLamports: row.rent_service_fee_lamports as string | undefined, sponsorReimbursementRaw: row.sponsor_reimbursement_raw as string | undefined, serviceFeeRaw: row.service_fee_raw as string | undefined, mint: row.mint as string | undefined, inputMint: row.input_mint as string | undefined, outputMint: row.output_mint as string | undefined, tokenAmountRaw: row.token_amount_raw as string | undefined, expectedOutputRaw: row.expected_output_raw as string | undefined, actualOutputRaw: row.actual_output_raw as string | undefined, minimumOutputRaw: row.minimum_output_raw as string | undefined, ataCreationLamports: row.ata_creation_lamports as string | undefined, outputAtaRentLamports: row.output_ata_rent_lamports as string | undefined, errorCode: row.error_code as string | undefined, errorStage: row.error_stage as string | undefined, createdAt: String(row.updated_at), updatedAt: String(row.updated_at) })));
  }
  private toRow(record: Partial<DurableTransactionRecord>) {
    const map: Record<string, string> = { intentId: 'intent_id', quoteId: 'quote_id', walletAddress: 'wallet_address', actionType: 'action_type', preparedMessageHash: 'prepared_message_hash', recentBlockhash: 'recent_blockhash', lastValidBlockHeight: 'last_valid_block_height', submittedAt: 'submitted_at', confirmedAt: 'confirmed_at', failedAt: 'failed_at', errorCode: 'error_code', errorStage: 'error_stage', createdAt: 'created_at', updatedAt: 'updated_at', batchIndex: 'batch_index', accountAddresses: 'account_addresses', grossRecoveredLamports: 'gross_recovered_lamports', gaslessFeeLamports: 'gasless_fee_lamports', sponsoredCostLamports: 'sponsored_cost_lamports', netUserLamports: 'net_user_lamports', relayerAddress: 'relayer_address', feeDestination: 'fee_destination', mint: 'mint', tokenAccount: 'token_account', tokenAmountRaw: 'token_amount_raw', tokenDecimals: 'token_decimals', mintSupplyRaw: 'mint_supply_raw', estimatedSwapOutputLamports: 'estimated_swap_output_lamports', minimumSwapOutputLamports: 'minimum_swap_output_lamports', swapServiceFeeLamports: 'swap_service_fee_lamports', rentServiceFeeLamports: 'rent_service_fee_lamports', networkFeeLamports: 'network_fee_lamports', temporaryAccountRentLamports: 'temporary_account_rent_lamports', recipientWallet: 'recipient_wallet', destinationAccount: 'destination_account', recipientAtaCreated: 'recipient_ata_created', recipientAmountRaw: 'recipient_amount_raw', sponsorReimbursementRaw: 'sponsor_reimbursement_raw', serviceFeeRaw: 'service_fee_raw', totalDebitRaw: 'total_debit_raw', ataCreationLamports: 'ata_creation_lamports', reimbursementDestination: 'reimbursement_destination', serviceFeeDestination: 'service_fee_destination', inputMint: 'input_mint', outputMint: 'output_mint', routedInputRaw: 'routed_input_raw', expectedOutputRaw: 'expected_output_raw', minimumOutputRaw: 'minimum_output_raw', outputAccount: 'output_account', outputAtaCreated: 'output_ata_created', outputAtaRentLamports: 'output_ata_rent_lamports', slippageBps: 'slippage_bps', priceImpactBps: 'price_impact_bps', routeFingerprint: 'route_fingerprint' };
    map.outputTokenDecimals = 'output_token_decimals';
    map.actualOutputRaw = 'actual_output_raw';
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined).map(([key, value]) => [map[key] ?? key, value]));
  }
  private fromRow(row: SupabaseRow): DurableTransactionRecord {
    return { id: String(row.id), intentId: String(row.intent_id), quoteId: String(row.quote_id), walletAddress: String(row.wallet_address), actionType: row.action_type as DurableTransactionRecord['actionType'], network: row.network as 'devnet', status: row.status as DurableTransactionRecord['status'], preparedMessageHash: row.prepared_message_hash as string | undefined, recentBlockhash: row.recent_blockhash as string | undefined, lastValidBlockHeight: row.last_valid_block_height as number | undefined, signature: row.signature as string | undefined, submittedAt: row.submitted_at as string | undefined, confirmedAt: row.confirmed_at as string | undefined, failedAt: row.failed_at as string | undefined, errorCode: row.error_code as string | undefined, errorStage: row.error_stage as string | undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at), batchIndex: row.batch_index as number | undefined, accountAddresses: row.account_addresses as string[] | undefined, grossRecoveredLamports: row.gross_recovered_lamports as string | undefined, gaslessFeeLamports: row.gasless_fee_lamports as string | undefined, sponsoredCostLamports: row.sponsored_cost_lamports as string | undefined, netUserLamports: row.net_user_lamports as string | undefined, relayerAddress: row.relayer_address as string | undefined, feeDestination: row.fee_destination as string | undefined, mint: row.mint as string | undefined, tokenAccount: row.token_account as string | undefined, tokenAmountRaw: row.token_amount_raw as string | undefined, tokenDecimals: row.token_decimals as number | undefined, mintSupplyRaw: row.mint_supply_raw as string | undefined, estimatedSwapOutputLamports: row.estimated_swap_output_lamports as string | undefined, minimumSwapOutputLamports: row.minimum_swap_output_lamports as string | undefined, swapServiceFeeLamports: row.swap_service_fee_lamports as string | undefined, rentServiceFeeLamports: row.rent_service_fee_lamports as string | undefined, networkFeeLamports: row.network_fee_lamports as string | undefined, temporaryAccountRentLamports: row.temporary_account_rent_lamports as string | undefined, recipientWallet: row.recipient_wallet as string | undefined, destinationAccount: row.destination_account as string | undefined, recipientAtaCreated: row.recipient_ata_created as boolean | undefined, recipientAmountRaw: row.recipient_amount_raw as string | undefined, sponsorReimbursementRaw: row.sponsor_reimbursement_raw as string | undefined, serviceFeeRaw: row.service_fee_raw as string | undefined, totalDebitRaw: row.total_debit_raw as string | undefined, ataCreationLamports: row.ata_creation_lamports as string | undefined, reimbursementDestination: row.reimbursement_destination as string | undefined, serviceFeeDestination: row.service_fee_destination as string | undefined };
  }
}

function summarizeTransactions(records: DurableTransactionRecord[]) {
  const succeeded = new Set(['confirmed', 'reconciled']);
  const pending = new Set(['prepared', 'simulated', 'awaiting_user_signature', 'user_signed', 'validated', 'relaying', 'submitted']);
  const byAction: Record<string, number> = {};
  let sponsored = 0n;
  let sponsored24h = 0n;
  let serviceFeeLamports = 0n;
  const cutoff = Date.now() - 86_400_000;
  const reimbursementByMint: Record<string, string> = {};
  const serviceFeeByMint: Record<string, string> = {};
  const successfulByAction: Record<string, number> = {};
  for (const record of records) {
    byAction[record.actionType] = (byAction[record.actionType] ?? 0) + 1;
    if (succeeded.has(record.status)) {
      successfulByAction[record.actionType] = (successfulByAction[record.actionType] ?? 0) + 1;
      const sponsoredCost = BigInt(record.sponsoredCostLamports ?? '0');
      sponsored += sponsoredCost;
      if (Date.parse(record.updatedAt) >= cutoff) sponsored24h += sponsoredCost;
      serviceFeeLamports += BigInt(record.gaslessFeeLamports ?? '0') + BigInt(record.swapServiceFeeLamports ?? '0') + BigInt(record.rentServiceFeeLamports ?? '0');
      const reimbursementMint = record.mint ?? record.inputMint;
      if (reimbursementMint && record.sponsorReimbursementRaw) reimbursementByMint[reimbursementMint] = (BigInt(reimbursementByMint[reimbursementMint] ?? '0') + BigInt(record.sponsorReimbursementRaw)).toString();
      if (reimbursementMint && record.serviceFeeRaw) serviceFeeByMint[reimbursementMint] = (BigInt(serviceFeeByMint[reimbursementMint] ?? '0') + BigInt(record.serviceFeeRaw)).toString();
    }
  }
  const recent = [...records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100).map(({ id, quoteId, walletAddress, actionType, network, status, signature, sponsoredCostLamports, gaslessFeeLamports, sponsorReimbursementRaw, serviceFeeRaw, mint, inputMint, outputMint, tokenAmountRaw, expectedOutputRaw, actualOutputRaw, minimumOutputRaw, ataCreationLamports, outputAtaRentLamports, errorCode, errorStage, updatedAt }) => ({ id, quoteId, walletAddress, actionType, network, status, signature, sponsoredCostLamports, gaslessFeeLamports, sponsorReimbursementRaw, serviceFeeRaw, mint, inputMint, outputMint, tokenAmountRaw, expectedOutputRaw, actualOutputRaw, minimumOutputRaw, ataCreationLamports, outputAtaRentLamports, errorCode, errorStage, updatedAt }));
  return { totalActions: records.length, successCount: records.filter((record) => succeeded.has(record.status)).length, failureCount: records.filter((record) => record.status === 'failed').length, pendingCount: records.filter((record) => pending.has(record.status)).length, uniqueWalletCount: new Set(records.filter((record) => succeeded.has(record.status)).map((record) => record.walletAddress)).size, sponsoredLamports: sponsored.toString(), sponsored24hLamports: sponsored24h.toString(), serviceFeeLamports: serviceFeeLamports.toString(), reimbursementByMint, serviceFeeByMint, byAction, successfulByAction, recent };
}
