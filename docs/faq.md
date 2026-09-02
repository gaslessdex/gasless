# Frequently asked questions

## What does GASLESS do?

It lets eligible wallets clean, swap, or send supported Solana assets without first holding SOL for network fees.

## Do I need SOL?

Not for a supported sponsored action. GASLESS fronts the required SOL and discloses reimbursement in the quote.

## Who pays the network fee?

A restricted GASLESS relayer pays it. The action may reimburse that cost from the supported asset, separately from the GASLESS service fee.

## Is GASLESS custodial?

No. The user signs the transaction authorizing the exact asset action; GASLESS does not take custody of wallet balances.

## What is CLEAN?

CLEAN groups Claim SOL, Recover Value, and Burn.

## What happens when I burn a token?

The complete supported fungible-token balance is permanently destroyed, the emptied account is closed, and eligible account rent is returned after disclosed costs. Burn is irreversible.

## What is Recover Value?

It sells the complete balance of an approved token through the proven route, closes the source account, and returns the guaranteed net SOL outcome.

## Which tokens are supported?

Support is action-specific and server-authoritative. Exact mint, token program, account state, extensions, route health, and current policy all matter.

## Which DEXes and routes are used?

SWAP uses Jupiter and validates one approved underlying family: Raydium CLMM, Meteora DLMM, or PumpSwap. Recover Value currently uses only its proven Raydium-compatible route.

## What fees does GASLESS charge?

See [fees](fees.md). Sponsor reimbursement and GASLESS service fees are disclosed separately.

## Will GASLESS support EVM networks?

Yes. Robinhood Chain is the first planned EVM target, followed by Base and BNB Chain. EVM execution is not live.

## Is private or encrypted execution available?

No. Encrypted/private transaction execution is not part of Solana V1 and may be considered later.

## Is GASLESS open source?

The audited application and transaction architecture in this repository are Apache-2.0 licensed. Production secrets and private operator controls are intentionally excluded.
