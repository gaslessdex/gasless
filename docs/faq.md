# Frequently asked questions

## What does GASLESS do?

It lets eligible wallets clean, send, swap, or bridge supported assets without first acquiring native gas.

## Do I need SOL?

Not for an eligible sponsored Solana action. GASLESS fronts the approved origin network cost and discloses the action's reimbursement and service fee before authorization.

## Is GASLESS custodial?

No. Users authorize the exact transaction that moves their assets; GASLESS does not take custody of wallet balances.

## What is CLEAN?

CLEAN groups Claim SOL, Recover Value, and Burn. Burn is irreversible. Recover Value sells the complete approved balance through a currently valid route.

## What cross-chain path is active?

Robinhood Chain is an active destination for supported Solana-origin Relay routes. SOL, USDC, and USDT are proven origin examples and ETH/USDG are current destination examples, but availability is dynamic. Native Robinhood-origin, Base, and BNB execution are not active in this repository.

## Which tokens are supported?

Support is action-specific. Exact mint, token program, account state, extension profile, registry capability, current route, pricing, health, and policy all matter. See [token support](token-support.md).

## Are Token-2022 and xStocks supported?

Only tested profiles are accepted. Supported xStock profiles can participate in SEND and SWAP when their current capability and route checks pass. xStock Recover is unsupported. Unknown Token-2022 behavior fails closed.

## What fees does GASLESS charge?

See [fees](fees.md). Service fees, sponsor reimbursement, and external route/liquidity effects are distinct.

## Has GASLESS received a third-party audit?

This repository is a reviewed public source snapshot and documents a security-reviewed architecture. It does not claim an external audit unless a specific public report is linked.
