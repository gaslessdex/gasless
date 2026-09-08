# Token support

Token support is registry-, capability-, and runtime-dependent. GASLESS identifies a token by exact mint address and token program, never by symbol alone.

Capabilities are action-specific:

- SEND requires SEND and fee-payment eligibility.
- SWAP distinguishes input from output eligibility.
- Recover Value requires its own explicit capability and route support.
- Claim SOL and Burn apply their own technical account rules.

Supported tested Token-2022/xStock profiles may participate in SEND and SWAP. xStock Recover is unsupported. Transfer-fee, transfer-hook, non-transferable, frozen nonzero, or other semantic profiles are rejected unless the exact action has dedicated validated support. Unknown extensions fail closed.

Registry-listed tokens still undergo current ownership, authority, account-state, price, liquidity, route, pause, and provider-health checks. See [the token registry](token-registry.md).
