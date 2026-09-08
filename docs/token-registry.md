# Token registry

GASLESS uses a generated canonical runtime registry for Solana token policy.

## Identity and search

The authoritative identity is:

```text
exact mint address + token program
```

Name and symbol are display and search metadata only. The UI can search by name, symbol, or mint, but policy never relies on a ticker alone.

## Action-specific capabilities

Capabilities are independent. A token may be enabled for SEND, SWAP input, SWAP output, or Recover Value without being enabled for the others. SEND eligibility does not imply Recover eligibility, and SWAP eligibility does not imply Recover eligibility.

Tested supported Token-2022/xStock profiles can participate in SEND and SWAP when their exact profile and current runtime checks pass. xStock Recover is currently unsupported. Unknown or unverified Token-2022 extensions fail closed.

## Generation and runtime checks

Batch onboarding begins from a structured source and produces canonical runtime data after validation. The public snapshot includes the schema, generation boundary, search logic, and an empty generated artifact; it deliberately excludes the production XLSX, approval notes, operator reports, and runtime image cache.

A registry entry is not a permanent promise. Current account state, token program, extensions, pause state, route availability, liquidity, pricing freshness, and provider health can still reject an action.
