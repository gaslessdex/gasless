# Fees

GASLESS separates three kinds of economics:

1. **GASLESS service fee** for the action.
2. **Sponsor reimbursement** for eligible network and narrowly approved setup costs fronted by GASLESS.
3. **External route, bridge, and liquidity effects** reflected in a provider quote or minimum outcome.

| Action | GASLESS service fee | Sponsor reimbursement |
| --- | --- | --- |
| Claim SOL | 3% of recovered account rent | Applicable sponsored network cost |
| Burn | 3% of recovered account rent | Applicable sponsored network cost |
| Recover Value | 0.30% of minimum guaranteed swap output plus 3% of recovered source-account rent; no service-fee cap | Applicable network cost and approved temporary-account setup cost |
| Swap | 0.30% of the configured input basis | Applicable network and canonical output-account setup cost |
| Send | 0.10% of exact recipient amount, capped at $1 equivalent | Applicable network and canonical recipient-account setup cost |
| Bridge / Cross Chain | Route-dependent; no static GASLESS service fee is claimed by this snapshot | Eligible Solana origin cost is sponsored within policy |

Recover Value uses integer floor rounding for both percentage components and calculates its swap component from the minimum guaranteed output. Send's cap is evaluated using current server-authoritative pricing.

Cross-chain quotes can change with the selected source, destination asset, liquidity, provider route, and timing. The UI must show the current expected/minimum destination outcome and any provider or liquidity effects instead of implying a permanent fixed price.
