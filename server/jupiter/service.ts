import { createHash } from 'node:crypto';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { GaslessError } from '../errors.js';
import { requestWithBackoff } from '../network/retry.js';
import { log } from '../observability/logger.js';
import { countApiUsage } from '../observability/api-usage.js';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const JUPITER_SWAP_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const RAYDIUM_CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
export const RAYDIUM_CLMM_DEX = 'Raydium CLMM';
export const METEORA_DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const METEORA_DLMM_DEX = 'Meteora DLMM';
export const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMPSWAP_DEX = 'Pump.fun Amm';
export const APPROVED_DEX_FAMILIES = [RAYDIUM_CLMM_DEX, METEORA_DLMM_DEX, PUMPSWAP_DEX] as const;
export type ApprovedDexFamily = typeof APPROVED_DEX_FAMILIES[number];
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface JupiterInstruction { programId: string; accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>; data: string }
export interface JupiterBuild {
  inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string; swapMode: string; slippageBps: number; priceImpactPct?: string;
  routePlan: Array<{ swapInfo?: { label?: string; inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string }; percent?: number; bps?: number }>;
  computeBudgetInstructions: JupiterInstruction[]; setupInstructions: JupiterInstruction[]; swapInstruction: JupiterInstruction; cleanupInstruction?: JupiterInstruction | null;
  otherInstructions: JupiterInstruction[]; tipInstruction?: JupiterInstruction | null; addressesByLookupTableAddress: Record<string, string[]>;
  blockhashWithMetadata: { blockhash: number[]; lastValidBlockHeight: number };
}

export type JupiterQuote = Pick<JupiterBuild, 'inputMint' | 'outputMint' | 'inAmount' | 'outAmount' | 'otherAmountThreshold' | 'swapMode' | 'slippageBps' | 'priceImpactPct' | 'routePlan'>;
export interface JupiterQuoteRequest { inputMint: string; outputMint?: string; amount: string; slippageBps: number; dexes?: string[]; maxPriceImpactBps?: number }

export interface JupiterRequest { inputMint: string; outputMint?: string; inputTokenProgram?: string; outputTokenProgram?: string; amount: string; taker: string; payer: string; destinationTokenAccount?: string; slippageBps: number; dexes?: string[]; blockhashSlotsToExpiry?: number }
export interface JupiterExpectation extends JupiterRequest { outputMint?: string; outputAccount?: string; maxPriceImpactBps?: number }
export interface JupiterRouter { quote(input: JupiterQuoteRequest): Promise<JupiterQuote>; build(input: JupiterRequest): Promise<JupiterBuild>; validate(build: JupiterBuild, expected: JupiterExpectation, currentBlockHeight: number): void; }

function positiveInteger(value: string) { return /^\d+$/.test(value) && BigInt(value) > 0n; }
export function isApprovedDexFamily(value: string): value is ApprovedDexFamily { return (APPROVED_DEX_FAMILIES as readonly string[]).includes(value); }
export function approvedDexProgram(family: ApprovedDexFamily) {
  return family === RAYDIUM_CLMM_DEX ? RAYDIUM_CLMM_PROGRAM_ID : family === METEORA_DLMM_DEX ? METEORA_DLMM_PROGRAM_ID : PUMPSWAP_PROGRAM_ID;
}
export function routeDexFamily(build: Pick<JupiterBuild, 'routePlan'>): ApprovedDexFamily {
  const step = build.routePlan?.length === 1 ? build.routePlan[0] : undefined;
  const label = step?.swapInfo?.label;
  if (!label || !isApprovedDexFamily(label) || !((step.bps === 10_000) || (step.percent === 100))) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'GASLESS supports one approved DEX family per swap.');
  return label;
}
export function parsePriceImpactBps(value: string | undefined) {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_economics', 'Jupiter returned an invalid price impact.');
  const [whole, fraction = ''] = value.split('.');
  const scaled = BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4)) + (/[1-9]/.test(fraction.slice(4)) ? 1n : 0n);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_economics', 'Jupiter returned an invalid price impact.');
  return Number(scaled);
}
function assertInstruction(instruction: JupiterInstruction | null | undefined, allowed: Set<string>, label: string) {
  if (!instruction || !allowed.has(instruction.programId)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', `Jupiter returned an unsupported ${label}.`);
  try {
    new PublicKey(instruction.programId);
    for (const account of instruction.accounts) new PublicKey(account.pubkey);
    Buffer.from(instruction.data, 'base64');
  } catch { throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', `Jupiter returned a malformed ${label}.`); }
}

function associatedTokenAccount(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM_ID) { return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID))[0].toBase58(); }
export function wrappedSolAccount(owner: string) { return associatedTokenAccount(owner, WRAPPED_SOL_MINT); }

export function jupiterInstruction(value: JupiterInstruction) {
  return new TransactionInstruction({ programId: new PublicKey(value.programId), keys: value.accounts.map((account) => ({ pubkey: new PublicKey(account.pubkey), isSigner: account.isSigner, isWritable: account.isWritable })), data: Buffer.from(value.data, 'base64') });
}

export function routeFingerprint(build: JupiterBuild) {
  return createHash('sha256').update(JSON.stringify({ inputMint: build.inputMint, outputMint: build.outputMint, inAmount: build.inAmount, outAmount: build.outAmount, otherAmountThreshold: build.otherAmountThreshold, slippageBps: build.slippageBps, priceImpactPct: build.priceImpactPct, routePlan: build.routePlan, computeBudgetInstructions: build.computeBudgetInstructions, setupInstructions: build.setupInstructions, swapInstruction: build.swapInstruction, cleanupInstruction: build.cleanupInstruction, otherInstructions: build.otherInstructions, tipInstruction: build.tipInstruction, addressesByLookupTableAddress: build.addressesByLookupTableAddress, blockhashWithMetadata: build.blockhashWithMetadata })).digest('hex');
}

export class JupiterService implements JupiterRouter {
  private readonly quoteCache = new Map<string, { expiresAt: number; promise: Promise<JupiterQuote> }>();
  constructor(private readonly apiUrl: string, private readonly apiKey?: string, private readonly request: typeof fetch = fetch) {}
  async quote(input: JupiterQuoteRequest) {
    const key = JSON.stringify([input.inputMint, input.outputMint ?? WRAPPED_SOL_MINT, input.amount, input.slippageBps, input.dexes ?? [], input.maxPriceImpactBps ?? null]);
    const cached = this.quoteCache.get(key);
    if (cached && cached.expiresAt > Date.now()) { countApiUsage('cacheHits'); return cached.promise; }
    if (cached) this.quoteCache.delete(key);
    countApiUsage('cacheMisses');
    const promise = this.fetchQuote(input).catch((error) => { this.quoteCache.delete(key); throw error; });
    this.quoteCache.set(key, { expiresAt: Date.now() + 2_000, promise });
    if (this.quoteCache.size > 200) for (const [oldKey, value] of this.quoteCache) if (value.expiresAt <= Date.now()) this.quoteCache.delete(oldKey);
    return promise;
  }
  private async fetchQuote(input: JupiterQuoteRequest) {
    countApiUsage('jupiterQuoteRequests');
    if (!this.apiKey) throw new GaslessError('CONFIGURATION_ERROR', 'jupiter', 'Jupiter routing is not configured.');
    const outputMint = input.outputMint ?? WRAPPED_SOL_MINT;
    const quoteApiUrl = this.apiUrl.replace(/\/swap\/v2\/?$/, '/swap/v1');
    if (quoteApiUrl === this.apiUrl) throw new GaslessError('CONFIGURATION_ERROR', 'jupiter', 'Jupiter quote routing is not configured.');
    const params = new URLSearchParams({ inputMint: input.inputMint, outputMint, amount: input.amount, swapMode: 'ExactIn', slippageBps: String(input.slippageBps) });
    if (input.dexes?.length) params.set('dexes', input.dexes.join(','));
    let response: Response;
    try { response = await requestWithBackoff(() => this.request(`${quoteApiUrl}/quote?${params}`, { headers: { 'x-api-key': this.apiKey! }, signal: AbortSignal.timeout(10_000) }), { onRetry: (status, delayMs) => { if (status === 429) countApiUsage('rateLimitedResponses'); log('warn', 'jupiter_quote_retry_scheduled', { status, delayMs }); } }); }
    catch (error) { throw new GaslessError('JUPITER_UNAVAILABLE', 'jupiter', 'A live swap route is temporarily unavailable.', true, undefined, { cause: error }); }
    if (!response.ok) throw new GaslessError(response.status === 400 ? 'TOKEN_UNSUPPORTED' : 'JUPITER_UNAVAILABLE', 'jupiter', response.status === 400 ? 'No safe swap route is available for this pair right now.' : 'A live swap route is temporarily unavailable.', response.status !== 400);
    const quote = await response.json() as JupiterQuote;
    if (quote.inputMint !== input.inputMint || quote.outputMint !== outputMint || quote.inAmount !== input.amount || quote.swapMode !== 'ExactIn' || quote.slippageBps !== input.slippageBps) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The Jupiter preview does not match the approved request.');
    if (parsePriceImpactBps(quote.priceImpactPct) > (input.maxPriceImpactBps ?? 10_000) || !positiveInteger(quote.outAmount) || !positiveInteger(quote.otherAmountThreshold) || BigInt(quote.otherAmountThreshold) > BigInt(quote.outAmount)) throw new GaslessError('TOKEN_UNSUPPORTED', 'jupiter_economics', 'This swap would lose too much value at the current market price. Try a smaller amount.');
    const requiredDex = input.dexes?.length === 1 && isApprovedDexFamily(input.dexes[0]) ? input.dexes[0] : undefined;
    if (!requiredDex || routeDexFamily(quote) !== requiredDex || quote.routePlan.some((step) => !step.swapInfo?.inputMint || !step.swapInfo.outputMint || !positiveInteger(step.swapInfo.inAmount ?? '') || !positiveInteger(step.swapInfo.outAmount ?? ''))) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', requiredDex ? `No safe ${requiredDex} route is available for this swap.` : 'Jupiter returned an invalid preview route.');
    return quote;
  }
  async build(input: JupiterRequest) {
    countApiUsage('jupiterBuildRequests');
    if (!this.apiKey) throw new GaslessError('CONFIGURATION_ERROR', 'jupiter', 'Jupiter routing is not configured.');
    const outputMint = input.outputMint ?? WRAPPED_SOL_MINT;
    const blockhashSlotsToExpiry = input.blockhashSlotsToExpiry ?? 100;
    if (!Number.isInteger(blockhashSlotsToExpiry) || blockhashSlotsToExpiry < 100 || blockhashSlotsToExpiry > 150) throw new GaslessError('CONFIGURATION_ERROR', 'jupiter', 'Jupiter blockhash validity policy is invalid.');
    const params = new URLSearchParams({ inputMint: input.inputMint, outputMint, amount: input.amount, taker: input.taker, payer: input.payer, wrapAndUnwrapSol: String(outputMint === WRAPPED_SOL_MINT), slippageBps: String(input.slippageBps), maxAccounts: '24', blockhashSlotsToExpiry: String(blockhashSlotsToExpiry) });
    if (input.destinationTokenAccount) params.set('destinationTokenAccount', input.destinationTokenAccount);
    if (input.dexes?.length) params.set('dexes', input.dexes.join(','));
    if (outputMint === WRAPPED_SOL_MINT) params.set('nativeDestinationAccount', input.taker);
    let response: Response;
    try { response = await requestWithBackoff(() => this.request(`${this.apiUrl}/build?${params}`, { headers: { 'x-api-key': this.apiKey! }, signal: AbortSignal.timeout(10_000) }), { onRetry: (status, delayMs) => { if (status === 429) countApiUsage('rateLimitedResponses'); log('warn', 'jupiter_build_retry_scheduled', { status, delayMs }); } }); }
    catch (error) { throw new GaslessError('JUPITER_UNAVAILABLE', 'jupiter', 'A live swap route is temporarily unavailable.', true, undefined, { cause: error }); }
    if (!response.ok) throw new GaslessError(response.status === 400 ? 'TOKEN_UNSUPPORTED' : 'JUPITER_UNAVAILABLE', 'jupiter', response.status === 400 ? 'No safe swap route is available for this pair right now.' : 'A live swap route is temporarily unavailable.', response.status !== 400);
    return await response.json() as JupiterBuild;
  }
  validate(build: JupiterBuild, expected: JupiterExpectation, currentBlockHeight: number) {
    const outputMint = expected.outputMint ?? WRAPPED_SOL_MINT;
    if (build.inputMint === outputMint || build.inputMint !== expected.inputMint || build.outputMint !== outputMint || build.inAmount !== expected.amount || build.swapMode !== 'ExactIn' || build.slippageBps !== expected.slippageBps) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The Jupiter route does not match the approved request.');
    const priceImpactBps = parsePriceImpactBps(build.priceImpactPct);
    if (priceImpactBps > (expected.maxPriceImpactBps ?? 10_000)) throw new GaslessError('TOKEN_UNSUPPORTED', 'jupiter_economics', 'This swap would lose too much value at the current market price. Try a smaller amount.');
    if (!positiveInteger(build.outAmount) || !positiveInteger(build.otherAmountThreshold) || BigInt(build.otherAmountThreshold) > BigInt(build.outAmount)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The Jupiter route economics are invalid.');
    if (!Number.isSafeInteger(build.blockhashWithMetadata?.lastValidBlockHeight) || build.blockhashWithMetadata.lastValidBlockHeight <= currentBlockHeight || build.blockhashWithMetadata.lastValidBlockHeight - currentBlockHeight > 300 || build.blockhashWithMetadata.blockhash?.length !== 32) throw new GaslessError('QUOTE_EXPIRED', 'jupiter_validation', 'The Jupiter route is stale. Request a new preview.');
    if (!build.routePlan?.length || build.otherInstructions?.length || build.tipInstruction) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The Jupiter route contains unsupported instructions.');
    const requiredDex = expected.dexes?.length === 1 && isApprovedDexFamily(expected.dexes[0]) ? expected.dexes[0] : undefined;
    try { if (!requiredDex || routeDexFamily(build) !== requiredDex) throw new Error(); for (const step of build.routePlan) { const info = step.swapInfo; if (!info?.inputMint || !info.outputMint || !positiveInteger(info.inAmount ?? '') || !positiveInteger(info.outAmount ?? '')) throw new Error(); new PublicKey(info.inputMint); new PublicKey(info.outputMint); } if (!build.routePlan.some((step) => step.swapInfo?.inputMint === build.inputMint) || !build.routePlan.some((step) => step.swapInfo?.outputMint === build.outputMint)) throw new Error(); } catch { throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', requiredDex ? `No safe ${requiredDex} route is available for this swap.` : 'Jupiter returned an invalid route plan.'); }
    build.computeBudgetInstructions.forEach((instruction) => { assertInstruction(instruction, new Set([COMPUTE_BUDGET_PROGRAM_ID]), 'compute instruction'); const data = Buffer.from(instruction.data, 'base64'); if (instruction.accounts.length || !((data[0] === 2 && data.length === 5) || (data[0] === 3 && data.length === 9))) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'Jupiter returned an unsupported compute instruction.'); });
    if (build.setupInstructions.length > 2) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'Jupiter returned too many setup instructions.');
    const inputTokenProgram = expected.inputTokenProgram ?? TOKEN_PROGRAM_ID;
    const outputTokenProgram = expected.outputTokenProgram ?? TOKEN_PROGRAM_ID;
    if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(inputTokenProgram) || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(outputTokenProgram)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The route uses an unsupported token program.');
    const expectedOutputAccount = expected.outputAccount ?? wrappedSolAccount(expected.taker);
    const setupAccounts = new Map([[associatedTokenAccount(expected.taker, expected.inputMint, inputTokenProgram), { mint: expected.inputMint, program: inputTokenProgram }], [expectedOutputAccount, { mint: outputMint, program: outputTokenProgram }]]);
    const seenSetupAccounts = new Set<string>();
    build.setupInstructions.forEach((instruction) => { assertInstruction(instruction, new Set([ASSOCIATED_TOKEN_PROGRAM_ID]), 'setup instruction'); const keys = instruction.accounts.map((account) => account.pubkey); const flags = instruction.accounts.map((account) => `${Number(account.isSigner)}${Number(account.isWritable)}`).join(','); const expectedSetup = setupAccounts.get(keys[1] ?? ''); if (!expectedSetup || seenSetupAccounts.has(keys[1]!) || Buffer.from(instruction.data, 'base64').toString('hex') !== '01' || keys.length !== 6 || flags !== '11,01,00,00,00,00' || keys[0] !== expected.payer || keys[2] !== expected.taker || keys[3] !== expectedSetup.mint || keys[4] !== SYSTEM_PROGRAM_ID || keys[5] !== expectedSetup.program) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'Jupiter returned an unsafe setup instruction.'); seenSetupAccounts.add(keys[1]!); });
    assertInstruction(build.swapInstruction, new Set([JUPITER_SWAP_PROGRAM_ID]), 'swap instruction');
    if (!build.swapInstruction.accounts.some((account) => account.pubkey === expectedOutputAccount && account.isWritable && !account.isSigner)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The Jupiter route is not bound to the approved output account.');
    if (!requiredDex || !build.swapInstruction.accounts.some((account) => account.pubkey === approvedDexProgram(requiredDex) && !account.isSigner)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The route label does not match the approved DEX program.');
    if (outputMint === WRAPPED_SOL_MINT) {
      assertInstruction(build.cleanupInstruction, new Set([TOKEN_PROGRAM_ID]), 'cleanup instruction');
      const cleanupKeys = build.cleanupInstruction!.accounts.map((account) => account.pubkey);
      const cleanupFlags = build.cleanupInstruction!.accounts.map((account) => `${Number(account.isSigner)}${Number(account.isWritable)}`).join(',');
      if (Buffer.from(build.cleanupInstruction!.data, 'base64').toString('hex') !== '09' || cleanupKeys.length !== 3 || cleanupFlags !== '01,01,10' || cleanupKeys[0] !== expectedOutputAccount || cleanupKeys[1] !== expected.taker || cleanupKeys[2] !== expected.taker) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'Jupiter returned an unsafe cleanup instruction.');
    } else if (build.cleanupInstruction) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'Jupiter returned an unexpected cleanup instruction.');
    try { for (const [table, addresses] of Object.entries(build.addressesByLookupTableAddress ?? {})) { new PublicKey(table); if (!Array.isArray(addresses) || addresses.length > 256) throw new Error('invalid lookup table'); addresses.forEach((address) => new PublicKey(address)); } } catch { throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The Jupiter lookup table is invalid.'); }
    const signers = [...build.setupInstructions, build.swapInstruction, ...(build.cleanupInstruction ? [build.cleanupInstruction] : [])].flatMap((instruction) => instruction.accounts.filter((account) => account.isSigner).map((account) => account.pubkey));
    if (signers.some((signer) => signer !== expected.taker && signer !== expected.payer)) throw new GaslessError('JUPITER_ROUTE_REJECTED', 'jupiter_validation', 'The Jupiter route requested an unexpected signer.');
  }
}
