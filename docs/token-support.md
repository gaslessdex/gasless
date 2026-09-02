# Token support

GASLESS identifies a token by exact mint address and token program, never by symbol alone. The server registry grants capabilities independently: a token may be eligible for one action and unavailable for another.

Runtime checks still verify ownership, account state, authorities, extensions, executable routes, pricing freshness, liquidity policy, and pause state. Registry approval is not permanent health certification.

V1 economic paths default to ordinary fungible legacy SPL tokens. Unknown Token-2022 behavior fails closed. Transfer fees, transfer hooks, permanent delegates, non-transferable behavior, unusual authorities, frozen nonzero sources, NFTs, and other unproven profiles are rejected unless an exact tested policy explicitly supports them.

Claim SOL may use broader technical close eligibility than economic actions. Recover Value requires an exact curated mint and its proven route. Token availability can change through operator review and health controls.
