export function scaledTokenAmountToUi(amount: bigint, decimals: number, multiplier: number) {
  const decimalFactor = 10 ** decimals;
  return (Math.trunc(Number(amount) * multiplier) / decimalFactor).toString();
}
