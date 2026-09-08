export type CrossChainAsset = 'SOL' | 'USDC' | 'USDT' | 'ETH' | 'USDG';
export type CrossChainNetwork = 'solana' | 'robinhood';
export type CrossChainInputAsset = Extract<CrossChainAsset, 'SOL' | 'USDC' | 'USDT'>;
export type CrossChainOutputAsset = Extract<CrossChainAsset, 'ETH' | 'USDG'>;

export interface CrossChainQuoteRequest {
  walletAddress: string;
  recipient: string;
  inputAsset: CrossChainInputAsset;
  outputAsset: CrossChainOutputAsset;
  amount: string;
}

export interface CrossChainCost {
  amount: string;
  amountUsd: string;
  symbol: string;
}

export interface CrossChainQuote {
  quoteId: string;
  provider: 'Relay';
  sourceNetwork: 'solana';
  destinationNetwork: 'robinhood';
  inputAsset: CrossChainInputAsset;
  outputAsset: CrossChainOutputAsset;
  inputAmount: string;
  estimatedOutput: string;
  minimumOutput?: string;
  routeCost?: CrossChainCost;
  appFee: CrossChainCost;
  estimatedDurationSeconds?: number;
  expiresAt: string;
  recipient: string;
  executionReady: boolean;
}

export interface CrossChainExecutionRequest { quoteId: string; walletAddress: string }
export interface CrossChainPreparedTransaction {
  transactionId: string;
  quoteId: string;
  serializedTransaction: string;
  messageHash: string;
  expectedFeePayer: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  expiresAt: string;
}
export interface CrossChainSubmissionResult {
  transactionId: string;
  quoteId: string;
  signature: string;
  sourceStatus: 'confirmed' | 'pending';
  sponsorCostLamports?: string;
}
export type CrossChainStatus = 'preparing' | 'awaiting_signature' | 'submitted' | 'source_confirmed' | 'executing' | 'destination_confirmed' | 'completed' | 'failed' | 'refund_pending' | 'refunded' | 'unknown_retryable';
export type CrossChainFailureReason = 'route_unavailable' | 'quote_expired' | 'amount_too_small' | 'amount_too_large' | 'recipient_malformed' | 'sponsor_unavailable' | 'provider_unavailable' | 'unsupported_route' | 'execution_disabled';
