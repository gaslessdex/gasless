import * as Sentry from '@sentry/react';
import { SOLANA_MAINNET_CHAIN, SOLANA_DEVNET_CHAIN } from '@solana/wallet-standard-chains';
import { SolanaSignTransaction, type SolanaSignTransactionFeature, type SolanaTransactionVersion } from '@solana/wallet-standard-features';
import type { IdentifierString, Wallet, WalletAccount } from '@wallet-standard/base';
import { VersionedTransaction } from '@solana/web3.js';
import { assertSupportedWalletSignedTransaction, WalletMessageMismatchError, type WalletMutationDiagnostics } from './signing.js';

type SigningContext = { connectorName: string; phase: string };
export type WalletSigningFailureClassification = 'USER_EXPLICITLY_CANCELLED' | 'WALLET_SIGNING_TIMEOUT' | 'WALLET_PROVIDER_ERROR' | 'POST_SIGN_VERIFICATION_FAILED' | 'APP_ABORTED_SIGNING_FLOW' | 'UNKNOWN_WALLET_FAILURE';

export class WalletSigningError extends Error {
  constructor(public readonly classification: WalletSigningFailureClassification, public readonly providerCode: string, public readonly providerName: string, public readonly providerMessage: string, cause: unknown, public readonly mutationDiagnostics?: WalletMutationDiagnostics, public readonly userSignatureReturned = false) {
    super('Failed to sign transaction', { cause }); this.name = 'WalletSigningError';
  }
}

function safeErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, '[identifier]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|secret|signature)\b\s*[:=]\s*\S+/gi, '$1=[filtered]')
    .slice(0, 240);
}

function reportSigningFailure(error: unknown, context: SigningContext) {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = safeErrorText(error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
  const connector = safeErrorText(context.connectorName);
  const details = {
    phase: context.phase,
    connector,
    feature: SolanaSignTransaction,
    errorCode: code,
    causeName: cause instanceof Error ? cause.name : typeof cause,
    causeMessage: safeErrorText(cause),
  };
  console.error('[GASLESS] Wallet signing failed', JSON.stringify(details));
  Sentry.captureMessage('Wallet signing failed', { level: 'error', tags: { gasless_stage: context.phase, wallet_connector: connector, wallet_feature: SolanaSignTransaction, wallet_error_code: code }, extra: details });
  return details;
}

export function classifyWalletSigningFailure(error: unknown): WalletSigningFailureClassification {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (code === '4001' || code === '4001000' || /(?:the )?user (?:explicitly )?(?:rejected|denied|cancelled)|(?:rejected|denied|cancelled) by (?:the )?user/i.test(message)) return 'USER_EXPLICITLY_CANCELLED';
  if (name === 'TimeoutError' || code === 'TIMEOUT' || /wallet[^.]{0,80}(?:timed out|timeout)/i.test(message)) return 'WALLET_SIGNING_TIMEOUT';
  if (name === 'AbortError') return 'APP_ABORTED_SIGNING_FLOW';
  if (error instanceof Error || code) return 'WALLET_PROVIDER_ERROR';
  return 'UNKNOWN_WALLET_FAILURE';
}

function transactionVersion(transaction: Uint8Array): SolanaTransactionVersion {
  try {
    return VersionedTransaction.deserialize(transaction).version;
  } catch {
    throw new Error('The prepared Solana transaction is invalid.');
  }
}

function normalizeSignedTransaction(value: unknown) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') return undefined;
  return Uint8Array.from(value as unknown as ArrayLike<number>);
}

export async function signWalletStandardTransaction({ wallet, account, transaction, chain, connectorName }: {
  wallet: Wallet;
  account: WalletAccount;
  transaction: Uint8Array;
  chain: IdentifierString;
  connectorName: string;
}) {
  const feature = wallet.features[SolanaSignTransaction] as SolanaSignTransactionFeature[typeof SolanaSignTransaction] | undefined;
  const version = transactionVersion(transaction);
  if (!feature || !account.features.includes(SolanaSignTransaction)) throw new Error('The connected wallet cannot sign Solana transactions.');
  if (!feature.supportedTransactionVersions.includes(version)) throw new Error('The connected wallet does not support this Solana transaction version.');
  if (!wallet.chains.includes(chain) || !account.chains.includes(chain)) throw new Error('The connected wallet does not support the selected Solana network.');

  let signed: Uint8Array;
  try {
    const outputs = await feature.signTransaction({ account, transaction, chain });
    const normalized = normalizeSignedTransaction(outputs[0]?.signedTransaction);
    if (outputs.length !== 1 || !normalized) throw new Error('The wallet returned an unsupported signed transaction format.');
    signed = normalized;
  } catch (cause) {
    const details = reportSigningFailure(cause, { connectorName, phase: 'wallet_standard_sign_transaction' });
    throw new WalletSigningError(classifyWalletSigningFailure(cause), details.errorCode, details.causeName, details.causeMessage, cause, cause instanceof WalletMessageMismatchError ? cause.mutationDiagnostics : undefined);
  }
  try {
    return await assertSupportedWalletSignedTransaction(transaction, signed);
  } catch (cause) {
    const details = reportSigningFailure(cause, { connectorName, phase: 'wallet_post_sign_verification' });
    throw new WalletSigningError('POST_SIGN_VERIFICATION_FAILED', details.errorCode, details.causeName, details.causeMessage, cause, cause instanceof WalletMessageMismatchError ? cause.mutationDiagnostics : undefined, true);
  }
}

export function walletChainForNetwork(network: 'devnet' | 'mainnet-beta') {
  return network === 'devnet' ? SOLANA_DEVNET_CHAIN : SOLANA_MAINNET_CHAIN;
}
