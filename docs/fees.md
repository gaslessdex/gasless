# Fees

GASLESS presents two separate categories:

1. **Sponsor reimbursement** repays the applicable network fee and any specifically approved payer-funded setup cost.
2. **GASLESS service fees** pay for the action.

| Action | GASLESS service fee | Sponsor reimbursement |
| --- | --- | --- |
| Claim SOL | 3% of recovered account rent | Applicable sponsored network cost |
| Burn | 3% of recovered account rent | Applicable sponsored network cost |
| Recover Value | 0.30% of minimum guaranteed swap output, plus 3% of recovered source-account rent; no cap | Applicable network cost and approved temporary-account setup cost |
| Swap | 0.30% of the configured input basis | Applicable network and canonical output-account setup cost |
| Send | 0.10% of exact recipient amount, capped at $1 equivalent | Applicable network and canonical recipient-account setup cost |

Recover Value uses integer floor rounding for both service-fee components. Its swap component is calculated from Jupiter's `otherAmountThreshold`—the minimum guaranteed output—not an optimistic estimate. Sponsor reimbursement is deducted separately and is not described as a service fee.

Displayed output also reflects external routing and liquidity economics where applicable. Policies remain server-authoritative and transactions proceed only when the guaranteed user outcome covers all disclosed costs.
