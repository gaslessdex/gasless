import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { GaslessError } from '../errors.js';
import { log } from '../observability/logger.js';

export interface RelayerProvider {
  getFeePayerPublicKey(): Promise<string>;
  signTransaction(serializedTransaction: string, options?: { recoverAuthorization?: RecoverAuthorization }): Promise<string>;
  assertNetworkIdentity?(rpc: { isBlockhashValid(blockhash: string): Promise<boolean> }): Promise<void>;
}

export interface RecoverAuthorization { payload: string; signature: string }

export type KoraErrorCategory = 'KORA_POLICY_INVALID_TRANSACTION' | 'KORA_SIGNER_ERROR' | 'KORA_RPC_ERROR' | 'KORA_AUTH_ERROR' | 'KORA_RATE_LIMIT' | 'KORA_MALFORMED_RESPONSE';
export class KoraCallFailure extends Error {
  constructor(public readonly category: KoraErrorCategory, public readonly reason: string, public readonly httpStatus?: number, public readonly rpcCode?: number, public readonly payerSignatureReturned = false, public readonly broadcastAttempted = false, public readonly deterministicPreSignRejection = false) { super(reason); this.name = 'KoraCallFailure'; }
}
export function koraFailure(error: unknown) { const cause = error instanceof GaslessError ? (error as Error & { cause?: unknown }).cause : error; return cause instanceof KoraCallFailure ? cause : undefined; }

export class LocalDevnetRelayerProvider implements RelayerProvider {
  private readonly keypair: Keypair;
  constructor(secretKey: string | undefined, keypairPath?: string) {
    if (!secretKey && !keypairPath) throw new GaslessError('CONFIGURATION_ERROR', 'relayer', 'The local Devnet relayer is not configured.');
    try {
      const encoded = secretKey ?? readFileSync(keypairPath!, 'utf8');
      const bytes = JSON.parse(encoded) as unknown;
      if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('invalid key bytes');
      this.keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
    }
    catch (error) { throw new GaslessError('CONFIGURATION_ERROR', 'relayer', 'The local Devnet relayer configuration is invalid.', false, undefined, { cause: error }); }
  }
  async getFeePayerPublicKey() { return this.keypair.publicKey.toBase58(); }
  async signTransaction(serializedTransaction: string) {
    const bytes = Buffer.from(serializedTransaction, 'base64');
    try {
      const transaction = Transaction.from(bytes);
      if (!transaction.feePayer?.equals(this.keypair.publicKey)) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer', 'The relayer rejected this fee payer.');
      transaction.partialSign(this.keypair);
      return transaction.serialize({ requireAllSignatures: true, verifySignatures: true }).toString('base64');
    } catch (error) {
      if (error instanceof GaslessError) throw error;
      try {
        const transaction = VersionedTransaction.deserialize(bytes);
        if (!transaction.message.staticAccountKeys[0]?.equals(this.keypair.publicKey)) throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer', 'The relayer rejected this fee payer.');
        transaction.sign([this.keypair]);
        return Buffer.from(transaction.serialize()).toString('base64');
      } catch (versionedError) {
        if (versionedError instanceof GaslessError) throw versionedError;
        throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer', 'The relayer could not read this transaction.');
      }
    }
  }
}

export class KoraRelayerProvider implements RelayerProvider {
  private signer?: string;
  constructor(private readonly rpcUrl?: string, private readonly apiKey?: string, private readonly request: typeof fetch = fetch) {}
  async getFeePayerPublicKey() {
    if (this.signer) return this.signer;
    const result = await this.call<{ signer_address?: string }>('getPayerSigner', []);
    try { this.signer = new PublicKey(result.signer_address!).toBase58(); }
    catch { throw new GaslessError('RELAYER_POLICY_REJECTED', 'relayer', 'Kora returned an invalid fee payer.'); }
    return this.signer;
  }
  async signTransaction(serializedTransaction: string, options?: { recoverAuthorization?: RecoverAuthorization }) {
    const result = await this.call<{ signed_transaction?: string; signer_pubkey?: string }>('signTransaction', { transaction: serializedTransaction, ...(options?.recoverAuthorization ? { recover_authorization: options.recoverAuthorization } : {}) });
    if (!result.signed_transaction || !result.signer_pubkey || result.signer_pubkey !== await this.getFeePayerPublicKey()) throw koraError(new KoraCallFailure('KORA_MALFORMED_RESPONSE', 'Kora returned an unexpected signer response.', undefined, undefined, Boolean(result.signed_transaction)));
    try {
      const before = transactionMessage(serializedTransaction);
      const after = transactionMessage(result.signed_transaction);
      if (!before.equals(after)) throw new Error('message changed');
      return result.signed_transaction;
    } catch { throw koraError(new KoraCallFailure('KORA_MALFORMED_RESPONSE', 'Kora changed or malformed the authorized transaction message.', undefined, undefined, true)); }
  }
  async assertNetworkIdentity(rpc: { isBlockhashValid(blockhash: string): Promise<boolean> }) {
    let checkpoint: 'config' | 'payer' | 'blockhash' = 'config';
    try {
      const config = await this.call<{ fee_payers?: string[] }>('getConfig', []);
      checkpoint = 'payer';
      const payer = await this.getFeePayerPublicKey();
      if (!config.fee_payers?.includes(payer)) throw new Error('payer absent from Kora configuration');
      checkpoint = 'blockhash';
      const result = await this.call<{ blockhash?: string }>('getBlockhash', []);
      if (!result.blockhash || !await rpc.isBlockhashValid(result.blockhash)) throw new Error('Kora blockhash is not valid on configured Mainnet RPC');
    } catch (error) {
      if (error instanceof GaslessError && error.code === 'KORA_NOT_CONFIGURED') throw error;
      const failure = koraFailure(error);
      log('warn', 'kora_network_guard_failed', { checkpoint, category: failure?.category ?? 'IDENTITY_MISMATCH' });
      throw new GaslessError('RELAYER_POLICY_REJECTED', 'kora_network_guard', 'Kora Mainnet identity could not be established.', false, undefined, { cause: error });
    }
  }
  private async call<T>(method: string, params: unknown) {
    if (!this.rpcUrl || !this.apiKey) throw new GaslessError('KORA_NOT_CONFIGURED', 'relayer', 'Kora is not configured.');
    let response: Response;
    try { response = await this.request(this.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey }, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }), signal: AbortSignal.timeout(7_000) }); }
    catch { throw new GaslessError('RELAYER_DISABLED', 'relayer', 'GASLESS sponsorship is temporarily unavailable.', true, undefined, { cause: new KoraCallFailure('KORA_RPC_ERROR', 'Kora could not be reached.') }); }
    let body: { result?: T; error?: { code?: unknown; message?: unknown; data?: unknown } };
    try { body = await response.json() as { result?: T; error?: { code?: unknown; message?: unknown; data?: unknown } }; }
    catch {
      const category: KoraErrorCategory = response.status === 401 || response.status === 403 ? 'KORA_AUTH_ERROR' : response.status === 429 ? 'KORA_RATE_LIMIT' : response.status >= 500 ? 'KORA_RPC_ERROR' : 'KORA_MALFORMED_RESPONSE';
      throw koraError(new KoraCallFailure(category, category === 'KORA_MALFORMED_RESPONSE' ? 'Kora returned malformed JSON.' : `Kora returned HTTP ${response.status}.`, response.status));
    }
    if (!response.ok || body.error || !body.result) {
      const code = typeof body.error?.code === 'number' ? body.error.code : undefined; const reason = sanitizeKoraReason(body.error?.message ?? body.error?.data ?? `HTTP ${response.status}`);
      const category: KoraErrorCategory = response.status === 401 || response.status === 403 ? 'KORA_AUTH_ERROR' : response.status === 429 ? 'KORA_RATE_LIMIT' : /sign/i.test(reason) ? 'KORA_SIGNER_ERROR' : /rpc/i.test(reason) || response.status >= 500 ? 'KORA_RPC_ERROR' : body.error ? 'KORA_POLICY_INVALID_TRANSACTION' : 'KORA_MALFORMED_RESPONSE';
      const deterministic = category === 'KORA_POLICY_INVALID_TRANSACTION' && /invalid transaction|validation error|not in the allowed|fee payer cannot/i.test(reason);
      throw koraError(new KoraCallFailure(category, reason, response.status, code, false, false, deterministic));
    }
    return body.result;
  }
}

function sanitizeKoraReason(value: unknown) { const raw = typeof value === 'string' ? value : JSON.stringify(value ?? 'Kora rejected the request.'); return raw.replace(/https?:\/\/\S+/gi, '[REDACTED_URL]').replace(/(?:authorization|api[-_]?key|token|secret)\s*[:=]\s*\S+/gi, '[REDACTED_CREDENTIAL]').slice(0, 256); }
function koraError(failure: KoraCallFailure) { return new GaslessError('RELAYER_POLICY_REJECTED', 'relayer', 'Kora rejected this sponsored transaction.', false, undefined, { cause: failure }); }

function transactionMessage(serialized: string) {
  const bytes = Buffer.from(serialized, 'base64');
  try { return Transaction.from(bytes).serializeMessage(); }
  catch { return Buffer.from(VersionedTransaction.deserialize(bytes).message.serialize()); }
}
