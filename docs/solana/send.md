# SEND and Bridge

SEND transfers an exact recipient amount from the sender's canonical source account to the recipient's canonical associated token account. The sender reimburses sponsored costs and pays the service fee in the same approved token. No swap occurs inside native SEND.

If the recipient account is absent, GASLESS may create only the canonical account and includes its exact current cost in sponsor reimbursement. The recipient, mint, token program, source, destination, amount, reimbursement, service fee, payer outflow, and instruction roles are validated.

SEND support is registry- and capability-specific. Tested supported Token-2022/xStock profiles may be used when their current state and policy checks pass.

The Bridge tab is the Solana-origin cross-chain surface. It uses validated Relay routes to a supported destination, currently Robinhood Chain where available. That path is separate from native Solana SEND and does not imply native Robinhood-origin SEND.
