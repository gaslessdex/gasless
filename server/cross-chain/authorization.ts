import { createPrivateKey, sign } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { versionedMessageHash } from '../../chains/solana/transactions/clean.js';
import type { ValidatedRelayTransaction } from '../../chains/solana/relay/validator.js';
import { GaslessError } from '../errors.js';
import type { RelayAuthorization } from '../relayer/provider.js';

const AUTHORIZATION_TTL_SECONDS = 60;
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class RelayAuthorizationSigner {
  readonly publicKey: string;
  private readonly privateKey: ReturnType<typeof createPrivateKey>;

  constructor(encodedSecretKey: string) {
    try {
      const parsed = JSON.parse(encodedSecretKey) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('invalid secret key');
      const secret = Buffer.from(parsed);
      this.publicKey = new PublicKey(secret.subarray(32)).toBase58();
      this.privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, secret.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
    } catch (error) {
      throw new GaslessError('CONFIGURATION_ERROR', 'relay_authorization', 'The Relay authorization signing key is invalid.', false, undefined, { cause: error });
    }
  }

  authorize(validated: ValidatedRelayTransaction, now = new Date()): RelayAuthorization {
    let transaction: VersionedTransaction;
    try { transaction = VersionedTransaction.deserialize(Buffer.from(validated.serializedTransaction, 'base64')); }
    catch { throw new GaslessError('MESSAGE_MISMATCH', 'relay_authorization', 'The Relay transaction could not be authorized.'); }
    if (versionedMessageHash(transaction) !== validated.messageHash) throw new GaslessError('MESSAGE_MISMATCH', 'relay_authorization', 'The Relay transaction changed after validation.');
    const issuedAt = Math.floor(now.getTime() / 1000);
    const validatedExpiry = Math.floor(Date.parse(validated.expiresAt) / 1000);
    const expiresAt = Math.min(issuedAt + AUTHORIZATION_TTL_SECONDS, validatedExpiry);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) throw new GaslessError('QUOTE_EXPIRED', 'relay_authorization', 'The Relay validation has expired.');
    const claims = {
      schema_version: 'relay-authorization-v1',
      action: 'CROSS_CHAIN_RELAY',
      network: 'mainnet-beta',
      message_hash: validated.messageHash,
      fee_payer: validated.depositFeePayer,
      wallet: validated.wallet,
      relay_order_id: validated.orderId,
      relay_request_id: validated.relayRequestId,
      quote_id: validated.quoteId,
      input_asset: validated.inputAsset,
      input_mint: validated.inputMint,
      input_amount_raw: validated.inputAmountRaw,
      destination_chain_id: 4663,
      destination_asset: validated.destinationAsset,
      recipient: validated.recipient,
      max_sponsor_lamports: validated.expectedSponsorMaxLamports,
      nonce: crypto.randomUUID(),
      issued_at_unix_seconds: issuedAt,
      expires_at_unix_seconds: expiresAt,
    } as const;
    const payload = Buffer.from(JSON.stringify(claims), 'utf8');
    return { payload: payload.toString('base64url'), signature: bs58.encode(sign(null, payload, this.privateKey)) };
  }
}
