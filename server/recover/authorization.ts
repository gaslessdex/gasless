import { createPrivateKey, sign } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { TransactionQuote } from '../../shared/transactions/types.js';
import { GaslessError } from '../errors.js';
import type { RecoverAuthorization } from '../relayer/provider.js';
import { versionedMessageHash } from '../../chains/solana/transactions/clean.js';

const AUTHORIZATION_TTL_SECONDS = 60;
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export class RecoverAuthorizationSigner {
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
      throw new GaslessError('CONFIGURATION_ERROR', 'recover_authorization', 'The Recover authorization signing key is invalid.', false, undefined, { cause: error });
    }
  }

  authorize(quote: TransactionQuote, serializedTransaction: string, now = new Date()): RecoverAuthorization {
    const recover = quote.recover;
    if (!recover?.prepared || !recover.networkFeeLamports || recover.temporaryAccountRentLamports === undefined || !recover.sponsoredCostLamports || !recover.minimumUserPayoutLamports) throw new GaslessError('CONFIGURATION_ERROR', 'recover_authorization', 'Recover authorization facts are incomplete.');
    let transaction: VersionedTransaction;
    try { transaction = VersionedTransaction.deserialize(Buffer.from(serializedTransaction, 'base64')); }
    catch { throw new GaslessError('MESSAGE_MISMATCH', 'recover_authorization', 'The Recover transaction could not be authorized.'); }
    const messageHash = versionedMessageHash(transaction);
    const issuedAt = Math.floor(now.getTime() / 1000);
    const claims = {
      schema_version: 'recover-authorization-v1',
      action: 'CLEAN_RECOVER',
      network: quote.intent.network,
      pilot_wallet: quote.intent.walletAddress,
      source_token_account: recover.account.address,
      input_mint: recover.account.mint,
      input_amount_raw: recover.account.tokenAmountRaw,
      output_mint: recover.outputMint,
      expected_output_lamports: recover.estimatedSwapOutputLamports,
      minimum_output_lamports: recover.minimumSwapOutputLamports,
      minimum_user_payout_lamports: recover.minimumUserPayoutLamports,
      swap_fee_lamports: recover.swapServiceFeeLamports,
      rent_fee_lamports: recover.rentServiceFeeLamports,
      network_reimbursement_lamports: recover.networkFeeLamports,
      setup_rent_reimbursement_lamports: recover.temporaryAccountRentLamports,
      sponsored_cost_lamports: recover.sponsoredCostLamports,
      treasury: recover.feeDestination,
      message_hash: messageHash,
      quote_id: quote.quoteId,
      intent_id: quote.intent.intentId,
      nonce: crypto.randomUUID(),
      issued_at_unix_seconds: issuedAt,
      expires_at_unix_seconds: issuedAt + AUTHORIZATION_TTL_SECONDS,
    } as const;
    const payloadBytes = Buffer.from(JSON.stringify(claims), 'utf8');
    return { payload: payloadBytes.toString('base64url'), signature: bs58.encode(sign(null, payloadBytes, this.privateKey)) };
  }
}
