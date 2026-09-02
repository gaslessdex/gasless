# Security model

The primary invariant is that the GASLESS fee payer never becomes a general-purpose signing wallet.

Every sponsored action must be built from a known action shape, bound to one wallet and short-lived intent, economically bounded, simulated, signed by the user, semantically revalidated, approved by relayer policy, final-simulated, and submitted without rebuilding.

Key controls include:

- exact mint plus token-program identity;
- curated per-action token capabilities and live health checks;
- exact or narrowly bounded semantic validation of wallet-returned messages;
- explicit signer, account-role, program, route-family, destination, amount, and fee checks;
- one-time quotes, replay locks, idempotency, and rate limits;
- per-transaction, wallet, token, and global sponsorship budgets;
- bounded canonical account creation only;
- final signed simulation and same-byte submission;
- confirmation, reconciliation, accounting, pause controls, and redacted logs.

Wallet-added semantics are accepted only when the corresponding action policy explicitly recognizes and bounds them. Arbitrary additions fail closed. Kora independently enforces the relevant payer-side policy.

See [transaction lifecycle](transaction-lifecycle.md) and [relayer model](solana/relayer-model.md).
