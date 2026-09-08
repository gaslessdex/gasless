# EVM direction

Robinhood Chain is currently a supported destination for eligible Solana-origin Relay execution where a current route is available. The origin transaction and GASLESS sponsorship occur on Solana; Relay coordinates destination delivery and status.

Native EVM-origin GASLESS BRIDGE, SWAP, and SEND are separate future work. Base and BNB Chain are planned and not active for execution in this repository.

Future native EVM work must retain exact chain/domain binding, target and calldata policy, replay-safe authorization, bounded sponsorship, simulation, accounting, and reconciliation. See the [EVM foundation](https://github.com/gaslessdex/gasless-evm).
