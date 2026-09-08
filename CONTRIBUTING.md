# Contributing to GASLESS

GASLESS is financial software. Keep changes small, reviewable, and fail-closed.

## Setup

1. Install Node.js 22 or newer.
2. Copy `.env.example` to ignored `.env.local` and add only local credentials you control.
3. Run `npm ci`.
4. Run the frontend with `npm run dev`; run the API with `npm run dev:api` when needed.

## Pull requests

- Open a focused branch and explain the objective and security impact.
- Never commit secrets, keypairs, wallet recovery material, production addresses used as private policy, or personal machine paths.
- Preserve exact-message, simulation, replay, payer-outflow, and token-policy invariants.
- Add meaningful tests for new behavior and adversarial cases.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:ui`, and `npm run build`.
- Keep cross-chain source/destination domains, route policy, and signing order explicit in tests.
- Do not add production-derived registries, token-image caches, signer identities, pilot data, or operator runbooks to public changes.
- Do not add proprietary GASLESS artwork or other production-only visual assets. Keep public fallbacks simple and redistributable.
- Update public documentation when behavior or settled architecture changes.

Architecture starts at [docs/architecture.md](docs/architecture.md). Security-sensitive reports must use the private process in [SECURITY.md](SECURITY.md), never a public issue.
