# Transaction lifecycle

GASLESS uses different signing order for the two current transaction paths while preserving the same exact-authorization invariant.

## Solana-native sponsored actions

1. Read current state and validate wallet, action, token, and account eligibility.
2. Calculate sponsor reimbursement, service fee, and route economics separately.
3. Create a short-lived quote, build the canonical transaction, and simulate it.
4. Show the exact or minimum user outcome.
5. The user signs the prepared message.
6. GASLESS verifies the signature and exact permitted message semantics, rechecks critical state, and consumes replay/idempotency state.
7. Kora independently validates policy and adds only its fee-payer signature.
8. GASLESS simulates the fully signed bytes. If simulation fails, it does not broadcast.
9. GASLESS persists the canonical signature, submits the same bytes, confirms, and reconciles accounting.

## Solana-origin cross-chain actions

1. Validate the selected Solana source, destination chain, recipient, amount, and current Relay route.
2. Normalize the quote and show expected/minimum destination outcome and source sponsorship.
3. Validate the Relay-built Solana transaction against the exact quote, chain/domain, payer, user, assets, amounts, destination, route, fee bounds, expiry, and account roles.
4. Reserve bounded sponsorship and ask Kora to validate and sign only the payer slot.
5. Return the unchanged payer-signed transaction for the user's asset authorization.
6. Verify the wallet signed the exact same message and did not alter the payer signature or transaction semantics.
7. Final-simulate and broadcast the same fully signed Solana bytes.
8. Track Solana confirmation and Relay/onchain destination status, then reconcile durable accounting.

A changed route, amount, recipient, destination domain, fee, expired blockhash, or other material term requires a fresh transaction and authorization. Status checks never silently rebuild or rebroadcast an old authorization.
