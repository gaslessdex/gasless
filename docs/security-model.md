# Security model

The primary invariant is that the GASLESS fee payer never becomes a general-purpose signing wallet.

Every sponsored action is constrained by a known action shape and an exact, short-lived intent. The application and Kora apply independent checks before the payer can sponsor an eligible transaction.

Core controls include:

- authoritative token identity by exact mint address plus token program;
- action-specific registry capabilities and current token/account health checks;
- exact intent and message validation, including signer and account-role checks;
- source/destination chain and domain binding for cross-chain actions;
- Relay quote and transaction validation, including route, recipient, asset, amount, fee, and payer bindings;
- one-time quotes, replay locks, idempotent state transitions, and rate limiting;
- bounded per-transaction and aggregate sponsorship budgets plus low-balance controls;
- canonical account creation only where the action explicitly permits it;
- pre-sign and final signed simulation;
- execution of the same authorized message without material rebuilding;
- confirmation, destination-status tracking, durable reconciliation, and accounting;
- redacted observability and public-safe activity data.

For Solana-native actions, the user signs the server-built message before Kora adds only the payer signature. For the current Relay flow, Kora signs the validated payer slot first and the user signs the unchanged message afterward. In both flows, any unapproved change to programs, accounts, privileges, amounts, destinations, fees, route semantics, blockhash, or authorization domain fails closed.

Kora is an independent payer/signing-policy boundary. It may cover known network fees and narrowly approved canonical setup costs. It may not transfer arbitrary SOL or tokens, create arbitrary accounts, burn or close arbitrary accounts, change authorities, approve delegates, or fund arbitrary rent.

Exact production thresholds, signer identities, credentials, private endpoints, and incident procedures are deliberately not published.
