# Cross-chain overview

GASLESS currently supports a Solana-origin path to Robinhood Chain when Relay returns a compatible route and all application and sponsorship policy checks pass.

At a high level:

1. The user selects a supported Solana source asset, destination asset, amount, and recipient.
2. GASLESS obtains and normalizes a Relay route, using Jupiter-origin routing where applicable.
3. The UI shows the expected/minimum destination outcome and eligible origin sponsorship.
4. GASLESS validates the Relay transaction, source/destination domains, assets, account roles, payer, recipient, fees, expiry, and exact message.
5. Kora independently approves and signs the bounded Solana payer role.
6. The user authorizes the unchanged asset action.
7. GASLESS final-simulates and submits the same bytes, then tracks source and destination status and reconciles accounting.

SOL, USDC, and USDT are proven origin examples. ETH and USDG are current destination examples. They are not permanent universal promises: supported assets and routes are registry-, capability-, liquidity-, provider-, and policy-dependent.

See [Solana to Robinhood Chain](solana-to-robinhood.md) and the [security model](../security-model.md).
