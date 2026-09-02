# Architecture

GASLESS separates an untrusted browser from a server-authoritative transaction and policy layer.

```mermaid
flowchart TD
  W[Wallet] --> A[GASLESS app]
  A --> T[Transaction service]
  T --> P[Policy and token registry]
  T --> R[Jupiter routing]
  T --> S[Simulation and validation]
  S --> K[Restricted relayer]
  K --> L[Solana]
  L --> C[Confirmation and reconciliation]
```

The frontend displays intent and outcomes and requests the wallet's signature. The backend loads authoritative state, selects eligible tokens and routes, builds the transaction, stores a short-lived quote, validates wallet-returned semantics, coordinates the restricted relayer, submits identical signed bytes, and reconciles durable records.

Chain-specific Solana builders live under `chains/solana/`. Browser code lives under `src/`, private-capability server code under `server/`, and chain-neutral transaction types under `shared/`.

Production operator controls, signer policy, credentials, pilot access, and deployment topology are deliberately outside this public source snapshot.
