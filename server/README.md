# Server boundary

The server is the authoritative construction, policy, sponsorship, and reconciliation layer for GASLESS.

It owns wallet sessions, token capabilities, quotes, transaction builders, state rechecks, simulation, replay protection, rate limits, relayer coordination, durable records, and public-safe status data. Browser code never receives server credentials or direct control of the fee payer.

This public source includes the application transaction architecture and generic provider interfaces. Production operator routes, token-onboarding controls, pilot identities, signer policy, credentials, runbooks, and deployment topology are intentionally excluded.
