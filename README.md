# GASLESS

Clean, move, and use your assets without holding gas.

**SOLANA** — CLEAN · SWAP · SEND  
**EVM** — BRIDGE · SWAP · SEND

| Network | Actions | Status |
| --- | --- | --- |
| Solana | CLEAN · SWAP · SEND | V1 / Implemented |
| Robinhood Chain | BRIDGE · SWAP · SEND | Planned — First EVM Target |
| Base | BRIDGE · SWAP · SEND | Planned |
| BNB Chain | BRIDGE · SWAP · SEND | Planned |
| Other EVM-compatible networks | BRIDGE · SWAP · SEND | Extensible |

## What GASLESS does

GASLESS lets an eligible wallet perform supported asset actions without first acquiring native gas. The server constructs the exact transaction, the user authorizes their asset action, and a restricted relayer sponsors the network cost. Sponsor reimbursement and any GASLESS service fee are disclosed separately before signing.

Solana V1 provides:

- **CLEAN:** Claim SOL from eligible accounts, Recover Value through an approved route, or permanently Burn supported fungible tokens.
- **SWAP:** Jupiter-routed swaps restricted to individually approved Raydium CLMM, Meteora DLMM, or PumpSwap families.
- **SEND:** exact recipient transfers with same-token sponsor reimbursement and safe canonical recipient-account creation when required.

## Security model

The browser never chooses arbitrary instructions for sponsorship. GASLESS validates token identity by exact mint and token program, binds short-lived quotes to exact intent, verifies wallet-returned transaction semantics, rechecks current state, applies program and payer-outflow policy, simulates the final signed bytes, submits those same bytes, and reconciles the result. Unexpected instructions, route families, signers, account roles, or transaction mutations fail closed.

Solana V1 engineering and a controlled private-mainnet pilot are complete. Public sponsorship remains intentionally gated, token availability is operator-reviewed, and this repository does not claim unrestricted public-mainnet sponsorship.

Read [the architecture](docs/architecture.md), [security model](docs/security-model.md), and [transaction lifecycle](docs/transaction-lifecycle.md).

## Routing, fees, and tokens

Jupiter supplies composable Solana routes. GASLESS independently restricts and validates the selected underlying DEX family. Recover Value remains restricted to its proven Raydium-compatible path; Meteora and PumpSwap support applies to SWAP, not Recover Value.

Fees vary by action and sponsor costs are separate from service fees. See [fees](docs/fees.md) and [token support](docs/token-support.md).

## Local development

Requirements: Node.js 22 or newer and npm.

```bash
cp .env.example .env.local
npm ci
npm run dev
```

Run the backend separately when testing API flows:

```bash
npm run dev:api
```

Quality checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Real credentials belong only in ignored local or deployment configuration. The example environment file contains no credentials.

## Project links

- Website: [gasless.exchange](https://gasless.exchange)
- EVM foundation: [gaslessdex/gasless-evm](https://github.com/gaslessdex/gasless-evm)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reporting: [SECURITY.md](SECURITY.md)

Licensed under [Apache-2.0](LICENSE). Third-party names and marks belong to their respective owners.
