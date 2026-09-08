# Relayer model

The operational payer is separate from settlement funds and cannot act as a general-purpose wallet. Kora independently validates the expected payer, exact message or permitted semantics, signers, account roles, programs, routes, and bounded payer outflow.

For Solana-native CLEAN, SWAP, and SEND, the user signs first and Kora then fills only the payer signature. For the current Relay cross-chain transaction, Kora signs the validated payer slot first and the user signs the unchanged message second. Neither flow permits material modification after user authorization.

The payer may cover known network fees and narrowly approved canonical setup. It may not transfer arbitrary SOL or tokens, create arbitrary accounts, burn or close arbitrary accounts, change authority, approve delegates, or fund arbitrary rent. Low balance, exhausted budgets, policy failure, replay, or failed simulation stops sponsorship.
