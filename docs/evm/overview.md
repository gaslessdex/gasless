# EVM direction

GASLESS plans one shared EVM architecture for BRIDGE · SWAP · SEND. Robinhood Chain is the first target, followed by Base and BNB Chain.

The EVM design will use server-authoritative construction, chain-ID and domain binding, target and calldata allowlists, replay-safe authorization, bounded relayer sponsorship, simulation, accounting, and reconciliation adapted to EVM semantics. Existing audited protocols are preferred; custom GASLESS contracts require a concrete security need.

No EVM transaction execution is implemented in this Solana repository. See the architectural scaffold at [gaslessdex/gasless-evm](https://github.com/gaslessdex/gasless-evm).
