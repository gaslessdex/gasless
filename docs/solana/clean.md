# CLEAN

## Claim SOL

Closes safely eligible empty token accounts and returns stored SOL. Discovery and quote creation share one authoritative scan, and preparation replaces the conservative network-cost bound with the current calculated fee.

## Recover Value

Uses the complete balance of an exact approved legacy-SPL source, a current Jupiter route, and a guaranteed minimum outcome. It swaps to SOL, closes the source, handles the canonical temporary wrapped-SOL account when needed, deducts separately disclosed reimbursement and service fees, and returns the net payout.

Recover capability is independent from SEND and SWAP capability. xStock Recover and unverified Token-2022 Recover profiles are unsupported.

## Burn

Uses full-balance `BurnChecked`, closes the emptied account, settles rent-based fees, and returns the remainder. It excludes NFTs, partial burns, wSOL, delegated sources, and unsupported Token-2022 or authority profiles. The user receives an explicit irreversible warning.
