import { evaluateSendWalletGate } from '../../../chains/solana/send/validity.js';
import type { PreparedTransaction } from '../../../shared/transactions/types.js';

export function walletGateForPreparedTransaction(prepared: PreparedTransaction | undefined, responseReceivedAt: number, now = Date.now(), currentBlockHeight = prepared?.preparedBlockHeight) {
  return evaluateSendWalletGate(prepared, responseReceivedAt, now, currentBlockHeight);
}
