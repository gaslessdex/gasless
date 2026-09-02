import { PublicKey } from '@solana/web3.js';
import type { SolanaNetwork, WalletSession } from '../../shared/transactions/types.js';
import { GaslessError } from '../errors.js';
import type { TemporaryStore } from '../storage/temporary.js';

export class SessionService {
  constructor(private readonly temporary: TemporaryStore, private readonly ttlSeconds: number, private readonly network: SolanaNetwork = 'devnet') {}
  async create(walletAddress: string, network: SolanaNetwork, requestId: string) {
    if (network !== this.network) throw new GaslessError('UNSUPPORTED_NETWORK', 'session', `GASLESS is configured for ${this.network}.`, false, requestId);
    try { new PublicKey(walletAddress); } catch { throw new GaslessError('SESSION_ERROR', 'session', 'Connect a valid Solana wallet.', false, requestId); }
    const now = Date.now();
    const session: WalletSession = { sessionId: crypto.randomUUID(), walletAddress, network, requestId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlSeconds * 1000).toISOString() };
    await this.temporary.saveSession(session, this.ttlSeconds);
    return session;
  }
  async require(sessionId: string, walletAddress?: string) {
    const session = await this.temporary.getSession(sessionId);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) throw new GaslessError('SESSION_ERROR', 'session', 'Your wallet session expired. Reconnect and try again.');
    if (walletAddress && session.walletAddress !== walletAddress) throw new GaslessError('SESSION_ERROR', 'session', 'The connected wallet does not match this request.');
    return session;
  }
}
