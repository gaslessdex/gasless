export const SWAP_MINIMUM_QUOTE_REMAINING_MS = 45_000;
export const SWAP_WALLET_SIGNING_WINDOW_MS = 30_000;
export const SWAP_MINIMUM_WALLET_OPEN_WINDOW_MS = 25_000;
export const SWAP_SUBMISSION_BUFFER_MS = 15_000;
export const SWAP_MINIMUM_BLOCK_HEIGHT_MARGIN = 100;

export function swapSigningDeadline(expiresAt: string, now = Date.now()) {
  const quoteExpiry = Date.parse(expiresAt);
  if (!Number.isFinite(quoteExpiry) || quoteExpiry - now < SWAP_MINIMUM_QUOTE_REMAINING_MS) return null;
  return new Date(Math.min(now + SWAP_WALLET_SIGNING_WINDOW_MS, quoteExpiry - SWAP_SUBMISSION_BUFFER_MS)).toISOString();
}

export function signingDeadlineIsActive(expiresAt: string | undefined, now = Date.now()) {
  const expiry = Date.parse(expiresAt ?? '');
  return Number.isFinite(expiry) && now < expiry;
}

export function signingDeadlineHasMargin(expiresAt: string | undefined, now = Date.now(), minimumMs = SWAP_MINIMUM_WALLET_OPEN_WINDOW_MS) {
  const expiry = Date.parse(expiresAt ?? '');
  return Number.isFinite(expiry) && expiry - now >= minimumMs;
}
