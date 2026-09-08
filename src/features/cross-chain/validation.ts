export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const DECIMAL_AMOUNT_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

export function crossChainAmountError(value: string) {
  if (!value) return '';
  if (!DECIMAL_AMOUNT_PATTERN.test(value) || Number(value) <= 0 || !Number.isFinite(Number(value))) return 'Enter an amount greater than zero.';
  return '';
}

export function crossChainRecipientError(value: string) {
  if (!value) return '';
  return EVM_ADDRESS_PATTERN.test(value) ? '' : 'Enter a valid 0x wallet address.';
}
