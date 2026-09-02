# CLEAN

## Claim SOL

Closes safely eligible token accounts and returns stored SOL. A quote can batch a bounded number of eligible accounts while preserving one exact user authorization.

## Recover Value

Uses the complete balance of an exact approved legacy-SPL source, a fresh Jupiter build, and the proven Raydium-compatible route. It swaps to SOL, closes the source, handles the canonical temporary wrapped-SOL account when needed, deducts separately disclosed reimbursement and service fees, and returns the guaranteed net payout. Meteora and PumpSwap are not enabled for Recover Value.

## Burn

Uses full-balance `BurnChecked`, closes the emptied account, settles rent-based fees, and returns the remainder. It excludes NFTs, Token-2022, partial burns, wSOL, delegated sources, and unusual authorities in V1. The user receives an explicit irreversible warning.
