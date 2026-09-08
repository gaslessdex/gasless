# Server boundary

The server is the authoritative construction, policy, sponsorship, and reconciliation layer for GASLESS.

It owns wallet sessions, token capabilities, native and cross-chain quotes, transaction validation, state rechecks, simulation, replay protection, rate limits, Relay coordination, Kora payer requests, durable records, and public-safe status data. Browser code never receives provider credentials or direct control of the fee payer.

This public snapshot includes generic provider interfaces and action logic. Production identities, credentials, private operator routes, onboarding data, runbooks, exact operational limits, and deployment topology are deliberately excluded.
