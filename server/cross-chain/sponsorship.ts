import { VersionedTransaction } from '@solana/web3.js';
import { versionedMessageHash, versionedSignerSignatureIsValid } from '../../chains/solana/transactions/clean.js';
import type { ValidatedRelayTransaction } from '../../chains/solana/relay/validator.js';
import { GaslessError } from '../errors.js';
import type { RelayerProvider } from '../relayer/provider.js';
import type { RelayAuthorizationSigner } from './authorization.js';

function parse(serialized: string, stage: string) {
  try { return VersionedTransaction.deserialize(Buffer.from(serialized, 'base64')); }
  catch { throw new GaslessError('INVALID_REQUEST', stage, 'The Relay transaction could not be read.'); }
}
function empty(signature: Uint8Array | undefined) { return Boolean(signature?.every((byte) => byte === 0)); }
function unchanged(transaction: VersionedTransaction, validated: ValidatedRelayTransaction) {
  return transaction.version === 0 && versionedMessageHash(transaction) === validated.messageHash && transaction.message.recentBlockhash === validated.recentBlockhash && transaction.message.staticAccountKeys[0]?.toBase58() === validated.depositFeePayer && transaction.message.staticAccountKeys[1]?.toBase58() === validated.wallet;
}

/** The only server-side path from a Relay validation result to the sponsor signer. */
export async function sponsorSignValidatedRelayTransaction(validated: ValidatedRelayTransaction, relayer: RelayerProvider, authorizationSigner?: RelayAuthorizationSigner) {
  const expiry = Date.parse(validated.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new GaslessError('QUOTE_EXPIRED', 'relay_sponsor_boundary', 'The Relay transaction expired before sponsorship.');
  if (await relayer.getFeePayerPublicKey() !== validated.depositFeePayer) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relay_sponsor_boundary', 'The configured Relay sponsor changed.');
  const before = parse(validated.serializedTransaction, 'relay_sponsor_boundary');
  if (!unchanged(before, validated) || !empty(before.signatures[0]) || !empty(before.signatures[1])) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relay_sponsor_boundary', 'Only an unsigned validated Relay transaction may reach the sponsor.');
  const relayAuthorization = authorizationSigner?.authorize(validated);
  const signed = await relayer.signTransaction(validated.serializedTransaction, relayAuthorization ? { relayAuthorization } : undefined);
  const after = parse(signed, 'relay_sponsor_boundary');
  if (!unchanged(after, validated) || !versionedSignerSignatureIsValid(after, 0, validated.depositFeePayer) || !empty(after.signatures[1])) throw new GaslessError('MESSAGE_MISMATCH', 'relay_sponsor_boundary', 'The sponsor did not preserve the exact validated Relay message.');
  return signed;
}

export function validateUserSignedRelayTransaction(sponsorSigned: string, userSigned: string, validated: ValidatedRelayTransaction) {
  const sponsored = parse(sponsorSigned, 'relay_user_signature'); const returned = parse(userSigned, 'relay_user_signature');
  if (!unchanged(sponsored, validated) || !unchanged(returned, validated) || !versionedSignerSignatureIsValid(sponsored, 0, validated.depositFeePayer) || !Buffer.from(sponsored.signatures[0]).equals(Buffer.from(returned.signatures[0])) || !versionedSignerSignatureIsValid(returned, 0, validated.depositFeePayer) || !versionedSignerSignatureIsValid(returned, 1, validated.wallet)) throw new GaslessError('MESSAGE_MISMATCH', 'relay_user_signature', 'The fully signed Relay transaction does not match the sponsor-authorized message.');
  return userSigned;
}
