import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createServices } from './app.js';
import { assertExpectedKoraPayer, assertPrivateWalletRoles, loadServerConfig } from './config/env.js';
import { GaslessError, asGaslessError, publicError } from './errors.js';
import { log } from './observability/logger.js';
import { captureOperationalFailure, initializeServerSentry } from './observability/sentry.js';
import { assertCanonicalMainnetMints } from './token-registry/mainnet.js';
import { buildPublicStats } from './operator/public-data.js';

const config = loadServerConfig();
initializeServerSentry(config.sentryDsn, config.operatingMode);
const services = createServices(config);
const parsedBodies = new WeakMap<IncomingMessage, Record<string, unknown>>();
let startupValidation: Promise<void> | undefined;

async function validateStartup() {
  await services.rpc.assertNetworkIdentity();
  if (config.operatingMode === 'private-mainnet') {
    const recoverEntries = config.recoverAllowedMints.map((mint) => ({ mint, symbol: mint, decimals: mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' || mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' ? 6 : -1, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', extensions: [], status: 'supported' as const, enabledActions: ['CLEAN_RECOVER' as const] }));
    await assertCanonicalMainnetMints(services.rpc, [...config.sendTokens, ...config.swapTokens, ...recoverEntries]);
    if (!services.relayer.assertNetworkIdentity) throw new Error('Kora network verification is unavailable.');
    await services.relayer.assertNetworkIdentity(services.rpc);
    const payer = await services.relayer.getFeePayerPublicKey();
    assertExpectedKoraPayer(payer, config.koraExpectedPayer);
    const settlements = [config.claimFeeDestination, config.burnFeeDestination, config.recoverFeeDestination, config.sendReimbursementWallet, config.sendServiceFeeWallet, config.swapReimbursementWallet, config.swapServiceFeeWallet];
    assertPrivateWalletRoles(config.pilotWalletAllowlist, settlements, payer);
  }
}

async function body(request: IncomingMessage) {
  const cached = parsedBodies.get(request);
  if (cached) return cached;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new Error('Request too large');
    chunks.push(chunk);
  }
  const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
  parsedBodies.set(request, parsed);
  return parsed;
}

function send(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  response.end(JSON.stringify(value));
}

export const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
  const requestId = String(request.headers['x-request-id'] ?? crypto.randomUUID());
  try {
    await (startupValidation ??= validateStartup());
    const url = new URL(request.url ?? '/', 'http://localhost');
    const routedPath = url.searchParams.get('__path');
    if (routedPath) url.pathname = `/api/${routedPath.replace(/^\/+/, '')}`;
    if (request.method === 'GET' && url.pathname === '/api/public/status') {
      const controls = await services.durable.getControls();
      const tokens = [...new Map([...(await services.registry.list('SEND')), ...(await services.registry.list('SWAP'))].map((token) => [token.mint, token])).values()];
      let operational = false; try { await services.rpc.assertNetworkIdentity(); operational = true; } catch { /* public-safe degraded state */ }
      return send(response, 200, { network: config.network, networkLabel: config.network === 'mainnet-beta' ? 'Solana Mainnet' : 'Solana Devnet', gaslessStatus: operational ? 'operational' : 'degraded', sponsorshipAvailable: controls.globalExecutionEnabled && controls.relayerEnabled && (config.network === 'mainnet-beta' ? controls.mainnetEnabled : controls.devnetEnabled), supportedTokenCount: tokens.length });
    }
    if (request.method === 'GET' && url.pathname === '/api/public/stats') {
      const localPilot = !process.env.VERCEL;
      if (!config.publicStatsEnabled && !localPilot) return send(response, 200, buildPublicStats(false, config.network));
      const [metrics, tokens] = await Promise.all([services.durable.getOperatorMetrics(config.network), services.registry.list('SWAP')]);
      return send(response, 200, buildPublicStats(true, config.network, metrics, tokens.length, localPilot && !config.publicStatsEnabled ? 'local-private-pilot' : 'public'));
    }
    if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { ok: true, network: config.network, operatingMode: config.operatingMode });
    if (request.method === 'POST') {
      const route = url.pathname.match(/^\/api\/(session|transactions|claim|burn|recover|send|swap)(?:\/(quote|prepare|pre-wallet|submit|discover))?$/);
      if (route) {
        const input = await body(request);
        const action = route[1] === 'claim' ? 'CLEAN_CLAIM' : route[1] === 'burn' ? 'CLEAN_BURN' : route[1] === 'recover' ? 'CLEAN_RECOVER' : route[1] === 'send' ? 'SEND' : route[1] === 'swap' ? 'SWAP' : route[1] === 'transactions' ? 'DEVNET_PROOF' : 'SESSION';
        const stage = route[1] === 'session' ? 'session' : (route[2] ?? 'quote') as 'discover' | 'quote' | 'prepare' | 'pre-wallet' | 'submit';
        const clientAddress = String(request.headers['cf-connecting-ip'] ?? request.headers['x-forwarded-for'] ?? request.socket.remoteAddress ?? 'unknown').split(',')[0].trim();
        if (action === 'SESSION') await services.risk.enforceRequest(action, stage, String(input.walletAddress ?? ''), String(input.network ?? '') as typeof config.network, clientAddress);
        else {
          const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
          await services.risk.enforceRequest(action, stage, session.walletAddress, session.network, clientAddress);
        }
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/session') {
      const input = await body(request);
      return send(response, 201, await services.session.create(String(input.walletAddress ?? ''), String(input.network ?? '') as 'devnet', requestId));
    }
    if (request.method === 'POST' && url.pathname === '/api/transactions/quote') {
      const input = await body(request);
      const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const quote = await services.engine.createQuote({ walletAddress: session.walletAddress, network: session.network as 'devnet', actionType: 'DEVNET_PROOF', clientRequestId: String(input.clientRequestId ?? ''), requestId });
      return send(response, 201, { quoteId: quote.quoteId, intentId: quote.intent.intentId, status: quote.status, expiresAt: quote.expiresAt });
    }
    if (request.method === 'POST' && url.pathname === '/api/transactions/prepare') {
      const input = await body(request);
      const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const prepared = await services.engine.prepare(String(input.quoteId ?? ''), session.walletAddress, requestId);
      return send(response, 200, { ...prepared, simulation: { ...prepared.simulation, logs: undefined } });
    }
    if (request.method === 'POST' && url.pathname === '/api/transactions/submit') {
      const input = await body(request);
      const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const result = await services.engine.submit({ quoteId: String(input.quoteId ?? ''), walletAddress: session.walletAddress, signedTransaction: String(input.signedTransaction ?? ''), clientRequestId: String(input.clientRequestId ?? ''), requestId });
      return send(response, 200, result);
    }
    if (request.method === 'POST' && url.pathname === '/api/claim/discover') {
      const input = await body(request);
      const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { ...await services.claim.discover(session.walletAddress), network: session.network });
    }
    if (request.method === 'POST' && url.pathname === '/api/claim/status') {
      const input = await body(request);
      const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.claim.reconcileStatus(String(input.quoteId ?? ''), session.walletAddress, session.network));
    }
    if (request.method === 'POST' && url.pathname === '/api/claim/quote') {
      const input = await body(request);
      const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const quote = await services.claim.createQuote({ walletAddress: session.walletAddress, network: session.network as 'devnet', clientRequestId: String(input.clientRequestId ?? ''), requestId });
      return send(response, 201, { quoteId: quote.quoteId, status: quote.status, expiresAt: quote.expiresAt, claim: quote.claim });
    }
    if (request.method === 'POST' && url.pathname === '/api/claim/prepare') {
      const input = await body(request);
      const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const quote = await services.claim.prepare(String(input.quoteId ?? ''), session.walletAddress, requestId, true);
      const batch = quote.claim?.batches[0];
      if (!batch?.prepared) throw new GaslessError('INVALID_REQUEST', 'claim_prepare', 'Claim preparation was incomplete.');
      try { await services.risk.reserveTransactionExposure({ network: quote.intent.network, walletAddress: quote.intent.walletAddress, action: 'CLEAN_CLAIM', transactionId: batch.prepared.transactionId, amountLamports: Number(batch.sponsoredCostLamports) }); }
      catch (error) { await services.claim.abortBeforeWallet(quote, error); throw error; }
      const activated = await services.claim.activateSigningWindow(quote, requestId);
      const claim = activated.claim ? { ...activated.claim, batches: activated.claim.batches.map((item) => ({ ...item, prepared: item.prepared ? { ...item.prepared, simulation: { ...item.prepared.simulation, logs: undefined } } : undefined })) } : undefined;
      return send(response, 200, { quoteId: activated.quoteId, status: activated.status, expiresAt: activated.expiresAt, claim });
    }
    if (request.method === 'POST' && url.pathname === '/api/claim/blockheight') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { blockHeight: await services.claim.currentWalletGateBlockHeight(String(input.quoteId ?? ''), session.walletAddress) });
    }
    if (request.method === 'POST' && url.pathname === '/api/claim/wallet-blockheight') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { blockHeight: await services.claim.currentWalletApprovalBlockHeight(String(input.quoteId ?? ''), session.walletAddress) });
    }
    if (request.method === 'POST' && url.pathname === '/api/claim/wallet-event') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata as Record<string, unknown> : {};
      await services.claim.recordWalletEvent(String(input.quoteId ?? ''), session.walletAddress, String(input.event ?? ''), metadata);
      return send(response, 200, { recorded: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/claim/abort-wallet-approval') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.claim.abortWalletApproval(String(input.quoteId ?? ''), session.walletAddress, String(input.reason ?? ''), input.userSignatureReturned === true));
    }
    if (request.method === 'POST' && url.pathname === '/api/claim/abort-wallet-gate') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      await services.claim.abortWalletGate(String(input.quoteId ?? ''), session.walletAddress, String(input.reason ?? ''));
      return send(response, 200, { status: 'failed' });
    }
    if (request.method === 'POST' && url.pathname === '/api/claim/submit') {
      const input = await body(request);
      const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const result = await services.claim.submit({ quoteId: String(input.quoteId ?? ''), batchIndex: Number(input.batchIndex), walletAddress: session.walletAddress, signedTransaction: String(input.signedTransaction ?? ''), clientRequestId: String(input.clientRequestId ?? ''), requestId });
      return send(response, 200, result);
    }
    if (request.method === 'POST' && url.pathname === '/api/burn/discover') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { ...await services.burn.discover(session.walletAddress), network: session.network });
    }
    if (request.method === 'POST' && url.pathname === '/api/burn/status') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.burn.reconcileStatus(String(input.quoteId ?? ''), session.walletAddress, session.network));
    }
    if (request.method === 'GET' && url.pathname === '/api/swap/tokens') return send(response, 200, { tokens: await services.swap.listTokens() });
    if (request.method === 'POST' && url.pathname === '/api/swap/discover') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.swap.discover(session.walletAddress, session.network));
    }
    if (request.method === 'POST' && url.pathname === '/api/swap/quote') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const quote = await services.swap.createQuote({ walletAddress: session.walletAddress, network: session.network as 'devnet', inputMint: String(input.inputMint ?? ''), outputMint: String(input.outputMint ?? ''), amount: String(input.amount ?? ''), slippageBps: input.slippageBps === undefined ? undefined : Number(input.slippageBps), clientRequestId: String(input.clientRequestId ?? ''), requestId, authorityVersion: Date.now() });
      return send(response, 201, { quoteId: quote.quoteId, status: quote.status, expiresAt: quote.expiresAt, swap: quote.swap ? { ...quote.swap, route: undefined } : undefined });
    }
    if (request.method === 'POST' && url.pathname === '/api/swap/prepare') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? '')); const quote = await services.swap.prepare(String(input.quoteId ?? ''), session.walletAddress, requestId);
      await services.risk.reserveQuoteExposure(quote);
      return send(response, 200, { quoteId: quote.quoteId, status: quote.status, expiresAt: quote.expiresAt, swap: quote.swap ? { ...quote.swap, route: undefined, prepared: quote.swap.prepared ? { ...quote.swap.prepared, simulation: { ...quote.swap.prepared.simulation, logs: undefined } } : undefined } : undefined });
    }
    if (request.method === 'POST' && url.pathname === '/api/swap/submit') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.swap.submit({ quoteId: String(input.quoteId ?? ''), walletAddress: session.walletAddress, signedTransaction: String(input.signedTransaction ?? ''), clientRequestId: String(input.clientRequestId ?? ''), requestId }));
    }
    if (request.method === 'GET' && url.pathname === '/api/send/tokens') return send(response, 200, { tokens: await services.send.listTokens() });
    if (request.method === 'POST' && url.pathname === '/api/send/discover') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.send.discover(session.walletAddress, session.network));
    }
    if (request.method === 'POST' && url.pathname === '/api/send/quote') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const quote = await services.send.createQuote({ walletAddress: session.walletAddress, network: session.network as 'devnet', mint: String(input.mint ?? ''), recipient: String(input.recipient ?? ''), amount: input.amount === undefined ? undefined : String(input.amount), max: input.max === true, clientRequestId: String(input.clientRequestId ?? ''), requestId });
      return send(response, 201, { quoteId: quote.quoteId, status: quote.status, expiresAt: quote.expiresAt, send: quote.send ? { ...quote.send, prepared: undefined } : undefined });
    }
    if (request.method === 'POST' && url.pathname === '/api/send/prepare') {
      const requestReceivedAt = Date.now(); const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? '')); const quote = await services.send.prepare(String(input.quoteId ?? ''), session.walletAddress, requestId, requestReceivedAt, true);
      const reservationStarted = Date.now();
      try { await services.risk.reserveQuoteExposure(quote); }
      catch (error) { await services.send.abortBeforeWallet(quote, error); throw error; }
      const activated = await services.send.activateSigningWindow(quote, requestId, Date.now() - reservationStarted);
      const payload = { quoteId: activated.quoteId, status: activated.status, expiresAt: activated.expiresAt, send: activated.send ? { ...activated.send, prepared: activated.send.prepared ? { ...activated.send.prepared, simulation: { ...activated.send.prepared.simulation, logs: undefined } } : undefined } : undefined };
      const responseEnqueuedAt = new Date().toISOString();
      log('info', 'send_prepared_response_enqueued', { requestId, quoteId: activated.quoteId, transactionId: activated.send?.prepared?.transactionId, responseEnqueuedAt });
      return send(response, 200, payload, { 'X-Gasless-Send-Response-Enqueued-At': responseEnqueuedAt });
    }
    if (request.method === 'POST' && url.pathname === '/api/send/blockheight') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { blockHeight: await services.send.currentWalletGateBlockHeight(String(input.quoteId ?? ''), session.walletAddress) });
    }
    if (request.method === 'POST' && url.pathname === '/api/send/wallet-blockheight') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { blockHeight: await services.send.currentWalletApprovalBlockHeight(String(input.quoteId ?? ''), session.walletAddress) });
    }
    if (request.method === 'POST' && url.pathname === '/api/send/wallet-event') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata as Record<string, unknown> : {};
      await services.send.recordWalletEvent(String(input.quoteId ?? ''), session.walletAddress, String(input.event ?? ''), metadata);
      return send(response, 200, { recorded: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/send/abort-wallet-approval') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      await services.send.abortWalletApproval(String(input.quoteId ?? ''), session.walletAddress, String(input.reason ?? ''), input.userSignatureReturned === true);
      return send(response, 200, { status: 'failed' });
    }
    if (request.method === 'POST' && url.pathname === '/api/send/abort-wallet-gate') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      await services.send.abortWalletGate(String(input.quoteId ?? ''), session.walletAddress, String(input.reason ?? ''));
      return send(response, 200, { status: 'failed' });
    }
    if (request.method === 'POST' && url.pathname === '/api/send/submit') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.send.submit({ quoteId: String(input.quoteId ?? ''), walletAddress: session.walletAddress, signedTransaction: String(input.signedTransaction ?? ''), clientRequestId: String(input.clientRequestId ?? ''), requestId }));
    }
    if (request.method === 'POST' && url.pathname === '/api/recover/discover') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { ...await services.recover.discover(session.walletAddress), network: session.network });
    }
    if (request.method === 'POST' && url.pathname === '/api/recover/quote') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const quote = await services.recover.createQuote({ walletAddress: session.walletAddress, network: session.network as 'devnet', tokenAccount: String(input.tokenAccount ?? ''), clientRequestId: String(input.clientRequestId ?? ''), requestId });
      return send(response, 201, { quoteId: quote.quoteId, status: quote.status, expiresAt: quote.expiresAt, recover: quote.recover ? { ...quote.recover, route: undefined, prepared: undefined } : undefined });
    }
    if (request.method === 'POST' && url.pathname === '/api/recover/prepare') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? '')); const quote = await services.recover.prepare(String(input.quoteId ?? ''), session.walletAddress, requestId, true);
      if (!quote.recover?.prepared) throw new GaslessError('INVALID_REQUEST', 'recover_prepare', 'Recover Value preparation was incomplete.');
      try { await services.risk.reserveTransactionExposure({ network: quote.intent.network, walletAddress: quote.intent.walletAddress, action: 'CLEAN_RECOVER', transactionId: quote.recover.prepared.transactionId, amountLamports: Number(quote.recover.sponsoredCostLamports) }); }
      catch (error) { await services.recover.abortBeforeWallet(quote, error); throw error; }
      const activated = await services.recover.activateSigningWindow(quote, requestId);
      return send(response, 200, { quoteId: activated.quoteId, status: activated.status, expiresAt: activated.expiresAt, recover: activated.recover ? { ...activated.recover, route: undefined, prepared: activated.recover.prepared ? { ...activated.recover.prepared, simulation: { ...activated.recover.prepared.simulation, logs: undefined } } : undefined } : undefined });
    }
    if (request.method === 'POST' && url.pathname === '/api/recover/status') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.recover.reconcileStatus(String(input.quoteId ?? ''), session.walletAddress, session.network));
    }
    if (request.method === 'POST' && url.pathname === '/api/recover/blockheight') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { blockHeight: await services.recover.currentWalletGateBlockHeight(String(input.quoteId ?? ''), session.walletAddress) });
    }
    if (request.method === 'POST' && url.pathname === '/api/recover/wallet-blockheight') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { blockHeight: await services.recover.currentWalletApprovalBlockHeight(String(input.quoteId ?? ''), session.walletAddress) });
    }
    if (request.method === 'POST' && url.pathname === '/api/recover/wallet-event') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? '')); const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata as Record<string, unknown> : {};
      await services.recover.recordWalletEvent(String(input.quoteId ?? ''), session.walletAddress, String(input.event ?? ''), metadata); return send(response, 200, { recorded: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/recover/abort-wallet-approval') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? '')); return send(response, 200, await services.recover.abortWalletApproval(String(input.quoteId ?? ''), session.walletAddress, String(input.reason ?? ''), input.userSignatureReturned === true));
    }
    if (request.method === 'POST' && url.pathname === '/api/recover/abort-wallet-gate') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? '')); await services.recover.abortWalletGate(String(input.quoteId ?? ''), session.walletAddress, String(input.reason ?? '')); return send(response, 200, { status: 'failed' });
    }
    if (request.method === 'POST' && url.pathname === '/api/recover/submit') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.recover.submit({ quoteId: String(input.quoteId ?? ''), walletAddress: session.walletAddress, signedTransaction: String(input.signedTransaction ?? ''), clientRequestId: String(input.clientRequestId ?? ''), requestId }));
    }
    if (request.method === 'POST' && url.pathname === '/api/burn/quote') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const quote = await services.burn.createQuote({ walletAddress: session.walletAddress, network: session.network as 'devnet', tokenAccount: String(input.tokenAccount ?? ''), clientRequestId: String(input.clientRequestId ?? ''), requestId });
      return send(response, 201, { quoteId: quote.quoteId, status: quote.status, expiresAt: quote.expiresAt, burn: quote.burn });
    }
    if (request.method === 'POST' && url.pathname === '/api/burn/prepare') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? '')); const quote = await services.burn.prepare(String(input.quoteId ?? ''), session.walletAddress, requestId, true);
      if (!quote.burn?.prepared) throw new GaslessError('INVALID_REQUEST', 'burn_prepare', 'Burn preparation was incomplete.');
      try { await services.risk.reserveTransactionExposure({ network: quote.intent.network, walletAddress: quote.intent.walletAddress, action: 'CLEAN_BURN', transactionId: quote.burn.prepared.transactionId, amountLamports: Number(quote.burn.sponsoredCostLamports) }); }
      catch (error) { await services.burn.abortBeforeWallet(quote, error); throw error; }
      const activated = await services.burn.activateSigningWindow(quote, requestId);
      return send(response, 200, { quoteId: activated.quoteId, status: activated.status, expiresAt: activated.expiresAt, burn: activated.burn ? { ...activated.burn, prepared: activated.burn.prepared ? { ...activated.burn.prepared, simulation: { ...activated.burn.prepared.simulation, logs: undefined } } : undefined } : undefined });
    }
    if (request.method === 'POST' && url.pathname === '/api/burn/blockheight') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { blockHeight: await services.burn.currentWalletGateBlockHeight(String(input.quoteId ?? ''), session.walletAddress) });
    }
    if (request.method === 'POST' && url.pathname === '/api/burn/wallet-blockheight') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, { blockHeight: await services.burn.currentWalletApprovalBlockHeight(String(input.quoteId ?? ''), session.walletAddress) });
    }
    if (request.method === 'POST' && url.pathname === '/api/burn/wallet-event') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata as Record<string, unknown> : {};
      await services.burn.recordWalletEvent(String(input.quoteId ?? ''), session.walletAddress, String(input.event ?? ''), metadata);
      return send(response, 200, { recorded: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/burn/abort-wallet-approval') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.burn.abortWalletApproval(String(input.quoteId ?? ''), session.walletAddress, String(input.reason ?? ''), input.userSignatureReturned === true));
    }
    if (request.method === 'POST' && url.pathname === '/api/burn/abort-wallet-gate') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      await services.burn.abortWalletGate(String(input.quoteId ?? ''), session.walletAddress, String(input.reason ?? ''));
      return send(response, 200, { status: 'failed' });
    }
    if (request.method === 'POST' && url.pathname === '/api/burn/submit') {
      const input = await body(request); const session = await services.session.require(String(input.sessionId ?? ''), String(input.walletAddress ?? ''));
      return send(response, 200, await services.burn.submit({ quoteId: String(input.quoteId ?? ''), walletAddress: session.walletAddress, signedTransaction: String(input.signedTransaction ?? ''), clientRequestId: String(input.clientRequestId ?? ''), requestId }));
    }
    const match = request.method === 'GET' && url.pathname.match(/^\/api\/transactions\/([0-9a-f-]+)$/i);
    if (match) {
      const record = await services.engine.getTransaction(match[1]);
      return record ? send(response, 200, record) : send(response, 404, { error: { code: 'QUOTE_NOT_FOUND', message: 'Transaction not found.' } });
    }
    if (url.pathname.startsWith('/api/send/')) return send(response, 404, { error: { code: 'INVALID_REQUEST', stage: 'send_api', message: 'GASLESS Send is temporarily unavailable. Please try again later.' } });
    return send(response, 404, { error: { code: 'INVALID_REQUEST', message: 'Route not found.' } });
  } catch (error) {
    const normalized = asGaslessError(error, 'api', requestId);
    log(normalized.code === 'INTERNAL_ERROR' ? 'error' : 'warn', 'api_request_failed', { requestId, code: normalized.code, stage: normalized.stage });
    captureOperationalFailure(normalized, { requestId, route: request.url?.split(/[?#]/, 1)[0] ?? '/', network: config.network, operatingMode: config.operatingMode });
    return send(response, normalized.code === 'INTERNAL_ERROR' ? 500 : 400, publicError(normalized));
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer(handleRequest).listen(config.port, '127.0.0.1', () => log('info', 'api_started', { port: config.port, network: config.network }));
}
