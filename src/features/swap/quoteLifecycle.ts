import { SWAP_MINIMUM_QUOTE_REMAINING_MS, signingDeadlineHasMargin, signingDeadlineIsActive } from '../../../chains/solana/swap/validity.js';
import type { SwapDiscoveryResult } from '../../../shared/transactions/types.js';

export const QUOTE_REFRESH_LEAD_MS = SWAP_MINIMUM_QUOTE_REMAINING_MS;

export type SwapQuoteState = 'idle' | 'quoting' | 'quote-ready' | 'refreshing-quote' | 'validating' | 'preparing' | 'awaiting-signature' | 'submitting' | 'confirmed' | 'error';

export function quoteRefreshDelay(expiresAt: string | undefined, now = Date.now(), leadMs = QUOTE_REFRESH_LEAD_MS) {
  const expiry = Date.parse(expiresAt ?? '');
  if (!Number.isFinite(expiry)) return 0;
  return Math.max(0, expiry - now - leadMs);
}

export function shouldAcceptQuote(activeGeneration: number, responseGeneration: number, signingLocked = false) {
  return !signingLocked && activeGeneration === responseGeneration;
}

export function quoteIdForPrepare(state: string, quoteId: string | undefined, expiresAt: string | undefined, now = Date.now()) {
  return state === 'quote-ready' && quoteId && quoteRefreshDelay(expiresAt, now) > 0 ? quoteId : null;
}

export function shouldRefreshQuoteAfterPrepareError(code: string | undefined) {
  return code === 'QUOTE_NOT_FOUND' || code === 'QUOTE_EXPIRED' || code === 'MESSAGE_MISMATCH';
}

export function canSubmitSignedSwap(walletSigningExpiresAt: string | undefined, now = Date.now()) {
  return signingDeadlineIsActive(walletSigningExpiresAt, now);
}

export function canOpenWalletForSwap(walletSigningExpiresAt: string | undefined, now = Date.now()) {
  return signingDeadlineHasMargin(walletSigningExpiresAt, now);
}

export function confettiParticleCount(viewportWidth: number, reducedMotion: boolean) {
  if (reducedMotion) return 0;
  return viewportWidth <= 760 ? 48 : 92;
}

export const SWAP_SUCCESS_CONFETTI_MS = 3_000;
export const SWAP_SUCCESS_TOAST_MS = 6_500;

type SuccessFeedbackTimer = unknown;

export function createSwapSuccessFeedbackLifecycle(input: {
  schedule: (callback: () => void, delayMs: number) => SuccessFeedbackTimer;
  cancel: (timer: SuccessFeedbackTimer) => void;
  showToast: (signature: string | undefined) => void;
  showConfetti: (count: number) => void;
}) {
  const seenSignatures = new Set<string>();
  let activeSignature: string | undefined;
  let confettiTimer: SuccessFeedbackTimer | undefined;
  let toastTimer: SuccessFeedbackTimer | undefined;

  const cancelTimers = () => {
    if (confettiTimer !== undefined) input.cancel(confettiTimer);
    if (toastTimer !== undefined) input.cancel(toastTimer);
    confettiTimer = undefined;
    toastTimer = undefined;
  };

  return {
    show(signature: string, confettiCount: number) {
      if (seenSignatures.has(signature)) return false;
      seenSignatures.add(signature);
      cancelTimers();
      activeSignature = signature;
      input.showToast(signature);
      input.showConfetti(confettiCount);
      confettiTimer = input.schedule(() => {
        if (activeSignature === signature) input.showConfetti(0);
        confettiTimer = undefined;
      }, SWAP_SUCCESS_CONFETTI_MS);
      toastTimer = input.schedule(() => {
        if (activeSignature === signature) {
          activeSignature = undefined;
          input.showToast(undefined);
        }
        toastTimer = undefined;
      }, SWAP_SUCCESS_TOAST_MS);
      return true;
    },
    clear() {
      cancelTimers();
      activeSignature = undefined;
      input.showToast(undefined);
      input.showConfetti(0);
    },
    dispose() {
      cancelTimers();
      activeSignature = undefined;
    },
  };
}

export function discoveryReflectsSwapSettlement(discovery: SwapDiscoveryResult, inputMint: string, previousInputBalanceRaw: string, outputMint: string, previousOutputBalanceRaw?: string) {
  const input = discovery.inputTokens.find((token) => token.mint === inputMint)?.balanceRaw;
  const output = discovery.outputTokens.find((token) => token.mint === outputMint)?.balanceRaw;
  return (input === undefined || BigInt(input) < BigInt(previousInputBalanceRaw))
    && output !== undefined && BigInt(output) > BigInt(previousOutputBalanceRaw ?? '0');
}
