export type SolanaNetwork = 'devnet' | 'mainnet-beta';

export type TransactionAction =
  | 'DEVNET_PROOF'
  | 'CLEAN_CLAIM'
  | 'CLEAN_RECOVER'
  | 'CLEAN_BURN'
  | 'SWAP'
  | 'SEND'
  | 'CROSS_CHAIN';

export type TransactionStatus =
  | 'created'
  | 'prepared'
  | 'simulated'
  | 'awaiting_user_signature'
  | 'user_signed'
  | 'validated'
  | 'relaying'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'reconciled';

export interface WalletSession {
  sessionId: string;
  walletAddress: string;
  network: SolanaNetwork;
  requestId: string;
  createdAt: string;
  expiresAt: string;
}

export interface TransactionIntent {
  intentId: string;
  walletAddress: string;
  actionType: TransactionAction;
  network: SolanaNetwork;
  requestId: string;
  clientRequestId: string;
  createdAt: string;
  expiresAt: string;
  metadata: Readonly<Record<string, string>>;
}

export interface TransactionQuote {
  quoteId: string;
  intent: TransactionIntent;
  status: TransactionStatus;
  createdAt: string;
  expiresAt: string;
  transactionId?: string;
  preparedMessageHash?: string;
  lastValidBlockHeight?: number;
  simulation?: SimulationResult;
  prepared?: PreparedTransaction;
  claim?: ClaimQuoteDetails;
  recover?: RecoverQuoteDetails;
  burn?: BurnQuoteDetails;
  send?: SendQuoteDetails;
  swap?: SwapQuoteDetails;
}

export interface SwapToken extends SendToken {
  swapInputEnabled: boolean;
  swapOutputEnabled: boolean;
}

export interface SwapQuoteDetails {
  schemaVersion: 'swap-v1';
  inputToken: SwapToken;
  outputToken: Omit<SwapToken, 'balanceRaw' | 'sourceAccount'>;
  outputAccount: string;
  outputAtaExists: boolean;
  totalInputRaw: string;
  routedInputRaw: string;
  expectedOutputRaw: string;
  minimumOutputRaw: string;
  serviceFeeBps: number;
  serviceFeeRaw: string;
  sponsorReimbursementRaw: string;
  sponsoredCostLamports?: string;
  networkFeeLamports?: string;
  outputAtaRentLamports?: string;
  slippageBps: number;
  priceImpactBps: number;
  routeLabel: string;
  routeFingerprint: string;
  reimbursementDestination: string;
  serviceFeeDestination: string;
  expectedRelayer?: string;
  prepared?: PreparedTransaction;
  status: TransactionStatus;
  signature?: string;
  reconciliation?: ReconciliationResult;
  route: unknown;
}

export interface SwapDiscoveryResult {
  walletAddress: string;
  network: SolanaNetwork;
  scannedAt: string;
  inputTokens: SwapToken[];
  outputTokens: Array<Omit<SwapToken, 'balanceRaw'> & { balanceRaw?: string; outputAtaExists: boolean }>;
}

export interface SendToken {
  mint: string;
  symbol: string;
  name?: string;
  image?: string;
  decimals: number;
  tokenProgram: string;
  balanceRaw: string;
  sourceAccount: string;
  uiMultiplier?: number;
  tokenAccountSize?: number;
}

export interface SendQuoteDetails {
  schemaVersion: 'send-v1';
  token: SendToken;
  recipientWallet: string;
  destinationAccount: string;
  recipientAtaExists: boolean;
  max: boolean;
  recipientAmountRaw: string;
  sponsorReimbursementRaw: string;
  serviceFeeRaw: string;
  totalDebitRaw: string;
  networkFeeLamports?: string;
  ataCreationLamports?: string;
  sponsoredCostLamports?: string;
  reimbursementDestination: string;
  serviceFeeDestination: string;
  pricing?: {
    tokenUsdPriceMicros: string;
    solUsdPriceMicros: string;
    observedAt: string;
  };
  expectedRelayer?: string;
  prepared?: PreparedTransaction;
  status: TransactionStatus;
  signature?: string;
  reconciliation?: ReconciliationResult;
}

export interface SendDiscoveryResult {
  walletAddress: string;
  network: SolanaNetwork;
  scannedAt: string;
  tokens: SendToken[];
}

export interface RecoverAccount extends BurnAccount {
  symbol?: string;
  name?: string;
  image?: string;
}

export interface RecoverQuoteDetails {
  schemaVersion: 'recover-v1';
  account: RecoverAccount;
  outputMint: string;
  slippageBps: number;
  routeLabel: string;
  routeFamily?: 'Raydium CLMM' | 'Meteora DLMM' | 'Pump.fun Amm';
  routeFingerprint: string;
  wrappedSolState: { address: string; exists: boolean; lamports: string; amountRaw: string; stateFingerprint: string };
  estimatedSwapOutputLamports: string;
  minimumSwapOutputLamports: string;
  swapServiceFeeBps: number;
  swapServiceFeeLamports: string;
  rentServiceFeeBps: number;
  rentServiceFeeLamports: string;
  feeDestination: string;
  expectedRelayer?: string;
  sponsoredCostLamports?: string;
  networkFeeLamports?: string;
  temporaryAccountRentLamports?: string;
  minimumUserPayoutLamports?: string;
  prepared?: PreparedTransaction;
  status: TransactionStatus;
  signature?: string;
  reconciliation?: ReconciliationResult;
  route: unknown;
}

export interface RecoverDiscoveryResult {
  walletAddress: string;
  network: SolanaNetwork;
  scannedAt: string;
  accounts: RecoverAccount[];
  eligibleAccounts: RecoverAccount[];
  skippedAccounts: RecoverAccount[];
}

export interface BurnAccount {
  address: string;
  mint: string;
  tokenProgram: string;
  tokenAmountRaw: string;
  decimals: number;
  recoverableLamports: string;
  mintSupplyRaw: string;
  recoverValueAvailable?: boolean;
  stateFingerprint: string;
  eligible: boolean;
  reason?: string;
}

export interface BurnQuoteDetails {
  schemaVersion: 'burn-v1';
  account: BurnAccount;
  feeBps: number;
  feeDestination: string;
  expectedRelayer?: string;
  reclaimedRentLamports: string;
  gaslessFeeLamports: string;
  sponsoredCostLamports?: string;
  netUserLamports?: string;
  prepared?: PreparedTransaction;
  status: TransactionStatus;
  signature?: string;
  reconciliation?: ReconciliationResult;
}

export interface BurnDiscoveryResult {
  walletAddress: string;
  network: SolanaNetwork;
  scannedAt: string;
  walletBalanceLamports: string;
  accounts: BurnAccount[];
  eligibleAccounts: BurnAccount[];
  skippedAccounts: BurnAccount[];
}

export interface ClaimAccount {
  address: string;
  mint: string;
  tokenProgram: string;
  tokenAmountRaw: string;
  recoverableLamports: string;
  stateFingerprint: string;
  eligible: boolean;
  reason?: string;
}

export interface ClaimBatch {
  batchIndex: number;
  accounts: ClaimAccount[];
  grossRecoveredLamports: string;
  gaslessFeeLamports: string;
  sponsoredCostLamports?: string;
  netUserLamports?: string;
  prepared?: PreparedTransaction;
  status: TransactionStatus;
  signature?: string;
  reconciliation?: ReconciliationResult;
}

export interface ClaimQuoteDetails {
  schemaVersion: 'claim-v1';
  feeBps: number;
  feeDestination: string;
  expectedRelayer?: string;
  grossRecoveredLamports: string;
  gaslessFeeLamports: string;
  sponsoredCostLamports?: string;
  netUserLamports?: string;
  batches: ClaimBatch[];
}

export interface ClaimDiscoveryResult {
  walletAddress: string;
  network: SolanaNetwork;
  scannedAt: string;
  walletBalanceLamports: string;
  accounts: ClaimAccount[];
  eligibleAccounts: ClaimAccount[];
  skippedAccounts: ClaimAccount[];
}

export interface PreparedTransaction {
  transactionId: string;
  quoteId: string;
  intentId: string;
  walletAddress: string;
  network: SolanaNetwork;
  serializedTransaction: string;
  preparedMessageHash: string;
  expectedFeePayer: string;
  expectedSigners: string[];
  allowedProgramIds: string[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
  walletSigningReadyAt?: string;
  walletSigningExpiresAt?: string;
  walletSigningWindowMs?: number;
  preparedBlockHeight?: number;
  preparationTimeline?: {
    requestReceivedAt: string;
    stateChecksCompletedAt: string;
    pricingCompletedAt: string;
    blockhashFetchedAt: string;
    transactionBuiltAt: string;
    simulationCompletedAt: string;
    economicsValidatedAt: string;
    durablePreparationCompletedAt?: string;
    reservationCompletedAt?: string;
    signingDeadlineCreatedAt?: string;
  };
  preparationTimings?: {
    requestReceivedAt: string;
    quoteLookupMs: number;
    controlsMs: number;
    tokenRegistryMs: number;
    accountStateMs: number;
    sourceAccountMs: number;
    recipientAccountMs: number;
    treasuryAccountMs: number;
    pricingMs: number;
    payerAndRentMs: number;
    payerMs: number;
    rentMs: number;
    blockhashMs: number;
    transactionConstructionMs: number;
    feeCalculationMs: number;
    simulationMs: number;
    transactionBuildAndSimulationMs: number;
    initialBlockHeightMs: number;
    durablePersistenceMs: number;
    reservationMs?: number;
    finalBlockHeightMs?: number;
    activationPersistenceMs?: number;
    totalServerMs?: number;
  };
  simulation: SimulationResult;
}

export interface SimulationResult {
  success: boolean;
  errorCode?: string;
  logs?: string[];
  unitsConsumed?: number;
  provider: string;
  simulatedAt: string;
}

export interface ValidatedTransaction {
  transactionId: string;
  quoteId: string;
  serializedTransaction: string;
  messageHash: string;
  walletAddress: string;
  validatedAt: string;
}

export interface SubmissionResult {
  transactionId: string;
  signature: string;
  provider: string;
  submittedAt: string;
}

export type ConfirmationOutcome = 'confirmed_success' | 'confirmed_chain_error' | 'expired' | 'timeout_unknown' | 'rpc_failure';

export interface ConfirmationResult {
  signature: string;
  outcome: ConfirmationOutcome;
  slot?: number;
  error?: unknown;
  confirmedAt?: string;
}

export interface ReconciliationResult {
  transactionId: string;
  signature?: string;
  status: 'confirmed' | 'failed' | 'pending';
  networkFeeLamports?: string;
  reconciledAt: string;
}

export interface DurableTransactionRecord {
  id: string;
  intentId: string;
  quoteId: string;
  walletAddress: string;
  actionType: TransactionAction;
  network: SolanaNetwork;
  status: TransactionStatus;
  preparedMessageHash?: string;
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  signature?: string;
  submittedAt?: string;
  confirmedAt?: string;
  failedAt?: string;
  errorCode?: string;
  errorStage?: string;
  createdAt: string;
  updatedAt: string;
  batchIndex?: number;
  accountAddresses?: string[];
  grossRecoveredLamports?: string;
  gaslessFeeLamports?: string;
  sponsoredCostLamports?: string;
  netUserLamports?: string;
  relayerAddress?: string;
  feeDestination?: string;
  mint?: string;
  tokenAccount?: string;
  tokenAmountRaw?: string;
  tokenDecimals?: number;
  mintSupplyRaw?: string;
  estimatedSwapOutputLamports?: string;
  minimumSwapOutputLamports?: string;
  swapServiceFeeLamports?: string;
  rentServiceFeeLamports?: string;
  networkFeeLamports?: string;
  temporaryAccountRentLamports?: string;
  recipientWallet?: string;
  destinationAccount?: string;
  recipientAtaCreated?: boolean;
  recipientAmountRaw?: string;
  sponsorReimbursementRaw?: string;
  serviceFeeRaw?: string;
  totalDebitRaw?: string;
  ataCreationLamports?: string;
  reimbursementDestination?: string;
  serviceFeeDestination?: string;
  inputMint?: string;
  outputMint?: string;
  outputTokenDecimals?: number;
  routedInputRaw?: string;
  expectedOutputRaw?: string;
  minimumOutputRaw?: string;
  actualOutputRaw?: string;
  outputAccount?: string;
  outputAtaCreated?: boolean;
  outputAtaRentLamports?: string;
  slippageBps?: number;
  priceImpactBps?: number;
  routeFingerprint?: string;
  sourceAsset?: string;
  destinationChainId?: number;
  destinationAsset?: string;
  crossChainRecipient?: string;
  relayRequestId?: string;
  relayOrderId?: string;
  quoteExpiresAt?: string;
  crossChainStatus?: string;
}

export interface SystemControls {
  globalExecutionEnabled: boolean;
  relayerEnabled: boolean;
  devnetEnabled: boolean;
  mainnetEnabled: boolean;
  cleanEnabled: boolean;
  swapEnabled: boolean;
  sendEnabled: boolean;
  crossChainEnabled: boolean;
  proofEnabled: boolean;
  claimEnabled: boolean;
  recoverEnabled: boolean;
  burnEnabled: boolean;
  maintenanceMessage?: string;
}
