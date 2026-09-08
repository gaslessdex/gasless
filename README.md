# GASLESS

Clean, move, swap, bridge, and use supported assets without first acquiring native gas.

## Network status

| Network | Current role | Status |
| --- | --- | --- |
| Solana | CLEAN · SWAP · SEND and sponsored cross-chain origin | Active / implemented |
| Robinhood Chain | Destination for supported Solana-origin routes | Active where a current route is available |
| Base | Future execution target | Planned |
| BNB Chain | Future execution target | Planned |

Robinhood Chain destination support does not mean native Robinhood-origin BRIDGE, SWAP, or SEND execution is active.

## Product

On Solana, GASLESS provides:

- **CLEAN:** Claim SOL from eligible empty token accounts, Burn supported fungible balances, or Recover Value through an approved route.
- **SWAP:** Jupiter-routed swaps for action-approved assets and route families.
- **SEND:** exact recipient transfers with same-token sponsor reimbursement and canonical recipient-account creation when required.

For cross-chain execution, GASLESS obtains and validates a Relay route, sponsors eligible Solana origin costs, and tracks delivery to Robinhood Chain. SOL, USDC, and USDT are proven origin examples; ETH and USDG are current destination examples. Availability remains registry-, capability-, liquidity-, policy-, and route-dependent.

## Architecture and security

The browser never supplies arbitrary instructions for sponsorship. The backend resolves exact token identity and current state, builds or canonicalizes the action, validates routes and account roles, binds authorization to the exact message, applies replay and sponsorship controls, simulates, submits the authorized bytes, and reconciles the result. Kora is an independent payer and signing-policy boundary.

This repository contains the GASLESS architecture and public-safe implementation. Proprietary visual assets, production configuration, operator tooling, and security-sensitive infrastructure are intentionally excluded; the public build uses a minimal neutral visual fallback.

Read:

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Token registry](docs/token-registry.md)
- [Token support](docs/token-support.md)
- [Cross-chain architecture](docs/cross-chain/overview.md)
- [Fees](docs/fees.md)
- [Transaction lifecycle](docs/transaction-lifecycle.md)

## Local development

Requirements: Node.js 22 or newer and npm.

```bash
cp .env.example .env.local
npm ci
npm run dev
```

Run the API separately when testing server flows:

```bash
npm run dev:api
```

Quality checks:

```bash
npm run typecheck
npm run lint
npm test
npm run test:ui
npm run build
```

Real credentials belong only in ignored local or deployment configuration.

## Links

- Website: [gasless.exchange](https://gasless.exchange)
- EVM foundation: [gaslessdex/gasless-evm](https://github.com/gaslessdex/gasless-evm)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reporting: [SECURITY.md](SECURITY.md)

Licensed under [Apache-2.0](LICENSE). Third-party names and marks belong to their respective owners.
