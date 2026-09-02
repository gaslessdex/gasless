# Relayer model

The operational fee payer is separate from the settlement treasury and cannot act as a general-purpose wallet.

The backend submits only transactions built from approved action shapes. The relayer independently checks the expected payer identity, authorized message or permitted semantics, programs, signers, account roles, payer-funded actions, token and route policy, and bounded sponsor outflow before adding its signature.

The fee payer may cover known transaction fees and narrowly approved canonical account setup. It may not transfer arbitrary SOL or tokens, burn or close arbitrary accounts, change authority, approve delegates, or fund arbitrary rent. Low balance, budget exhaustion, policy failure, or simulation failure stops sponsorship.
