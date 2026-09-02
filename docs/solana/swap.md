# SWAP

SWAP uses Jupiter's composable build path, then constructs and validates the GASLESS transaction around that route.

The final V1 route families are Raydium CLMM, Meteora DLMM, and PumpSwap. They are not three independent GASLESS routers: Jupiter supplies the candidate route, while GASLESS requests, identifies, and validates exactly one approved underlying family. Token policy stores approved families per mint; the pair uses their intersection. Unknown, mixed-family, multi-step, and label/program-mismatched routes fail closed.

The connected wallet's canonical output account is the only output destination. Safe missing-account creation is atomic and reimbursed. Minimum output, slippage, price impact, total input, service fee, sponsor cost, signers, programs, route state, simulation, and reconciliation are bound to the action.
