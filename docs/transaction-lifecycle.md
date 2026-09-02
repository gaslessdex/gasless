# Transaction lifecycle

1. Read current onchain state.
2. Validate wallet, action, token, account, and route eligibility.
3. Calculate sponsor reimbursement and service fees separately.
4. Create a short-lived exact quote.
5. Build and simulate the canonical transaction.
6. Show the user the outcome and costs.
7. Request a wallet signature for the prepared action.
8. Verify the wallet signature and permitted transaction semantics.
9. Recheck critical state, economics, validity, and replay status.
10. Ask the restricted relayer to validate and add only its fee-payer signature.
11. Simulate the fully signed transaction.
12. If simulation fails, do not broadcast.
13. Persist the canonical signature, submit the same bytes, confirm, and reconcile.

A changed route, amount, recipient, fee, blockhash after expiry, or other material term requires a newly built transaction and a new user signature. Refresh and status checks never silently rebuild or rebroadcast an old authorization.
