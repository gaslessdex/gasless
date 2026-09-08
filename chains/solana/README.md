# Solana

Solana is the active GASLESS execution network.

This directory contains account rules, Token-2022 profile handling, validity windows, semantic wallet policy, native transaction builders, and Relay-origin transaction validation for CLEAN, SWAP, SEND, and cross-chain execution.

Solana-specific concepts such as lamports, associated token accounts, SPL Token, Token-2022, versioned transactions, and instruction validation remain here rather than in `shared/`. No custom GASLESS onchain program is required for the current architecture.
