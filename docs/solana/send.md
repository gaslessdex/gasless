# SEND

SEND transfers an exact recipient amount from the sender's canonical source account to the recipient's canonical associated token account.

The sender reimburses the sponsored cost and pays the service fee in the same approved token. No swap occurs inside SEND. If the recipient account is absent, GASLESS may create only the canonical account and includes its exact rent in sponsor reimbursement.

The recipient, mint, token program, source, destination, amount, reimbursement, fee, payer outflow, compute policy, and instruction order are validated. A token is available only when SEND and fee-payment policy are both enabled and a fresh executable token-to-USDC confidence route passes server checks.
