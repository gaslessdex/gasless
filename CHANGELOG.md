# Changelog

All notable public changes are documented here. GASLESS follows Semantic Versioning and the structure of Keep a Changelog.

## [Unreleased]

### Added

- Public-safe Relay integration and Solana-to-Robinhood Chain transaction validation.
- Cross-chain UI, status tracking, reconciliation types, and database state.
- Generated canonical Solana token-registry architecture with action-specific capabilities.
- Tested Token-2022/xStock Send and Swap account profiles; xStock Recover remains unsupported.
- Public browser-verification, activity, network-status, and retry behavior.

### Changed

- Updated the public source snapshot to the current GASLESS production architecture and interface.
- Documented Robinhood Chain as a supported destination where routes are available, distinct from future native EVM-origin execution.
- Documented the current native and cross-chain signing orders, security controls, provider roles, and fee model.
- Replaced ambiguous audit wording with accurate public-source and security-review language.
- Replaced production-only car artwork with a minimal CSS fallback in the public source tree.

## [0.1.0] - 2026-09-02

### Added

- Initial reviewed public source release for GASLESS Solana V1.
- CLEAN: Claim SOL, Burn, and Recover Value transaction architecture.
- SWAP with Jupiter-routed, individually validated Raydium CLMM, Meteora DLMM, and PumpSwap families.
- SEND with exact-recipient semantics and sponsored canonical recipient-account creation.
- Exact wallet authorization, relayer validation, simulation, replay protection, reconciliation, and public security tests.

This release reflects implemented V1 engineering and controlled mainnet proof. It does not claim unrestricted support for every token, wallet, route, or network.
