# SWAP and Cross Chain

Native SWAP uses Jupiter's composable build path and validates the GASLESS transaction around the selected route. The current approved underlying families are Raydium CLMM, Meteora DLMM, and PumpSwap. Jupiter supplies the candidate route; GASLESS requires the exact action-specific registry capability and validates the selected family, accounts, roles, output, fees, sponsor cost, and simulation.

The connected wallet's canonical output account is the only native SWAP destination. Missing canonical account creation is atomic and reimbursed. Tested supported Token-2022/xStock profiles may participate when their current capability and route checks pass.

The Cross Chain tab uses the separate Relay flow for a supported Solana source and destination-chain asset. Route availability is dynamic; it is not a permanent token whitelist and does not enable native Robinhood-origin SWAP.
