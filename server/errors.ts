export type GaslessErrorCode =
  | 'CONFIGURATION_ERROR' | 'SESSION_ERROR' | 'UNSUPPORTED_NETWORK' | 'ACTION_DISABLED'
  | 'TOKEN_UNSUPPORTED' | 'INSUFFICIENT_BALANCE' | 'QUOTE_NOT_FOUND' | 'QUOTE_EXPIRED' | 'QUOTE_ALREADY_USED'
  | 'INVALID_REQUEST' | 'SIMULATION_FAILED' | 'USER_SIGNATURE_INVALID' | 'MESSAGE_MISMATCH'
  | 'REPLAY_DETECTED' | 'RELAYER_DISABLED' | 'RELAYER_INSUFFICIENT_FUNDS'
  | 'WALLET_NOT_ALLOWED' | 'SPONSOR_LIMIT_EXCEEDED' | 'TOKEN_PAUSED'
  | 'RELAYER_POLICY_REJECTED' | 'KORA_NOT_CONFIGURED' | 'RPC_ERROR' | 'SUBMISSION_FAILED'
  | 'JUPITER_UNAVAILABLE' | 'JUPITER_ROUTE_REJECTED'
  | 'RELAY_UNAVAILABLE'
  | 'CONFIRMATION_TIMEOUT' | 'CHAIN_EXECUTION_FAILED' | 'RECONCILIATION_FAILED'
  | 'DATABASE_ERROR' | 'RATE_LIMITED' | 'INTERNAL_ERROR';

export class GaslessError extends Error {
  constructor(
    public readonly code: GaslessErrorCode,
    public readonly stage: string,
    public readonly safeMessage: string,
    public readonly retryable = false,
    public readonly requestId?: string,
    options?: { cause?: unknown },
  ) {
    super(safeMessage);
    if (options && 'cause' in options) (this as Error & { cause?: unknown }).cause = options.cause;
    this.name = 'GaslessError';
  }
}

export function asGaslessError(error: unknown, stage = 'unknown', requestId?: string): GaslessError {
  if (error instanceof GaslessError) return error;
  return new GaslessError('INTERNAL_ERROR', stage, 'GASLESS could not complete this request.', false, requestId, { cause: error });
}

export function publicError(error: GaslessError) {
  return { error: { code: error.code, stage: error.stage, message: error.safeMessage, retryable: error.retryable, requestId: error.requestId } };
}
