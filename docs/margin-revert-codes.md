# MarginModule revert codes

`Dex223MarginModule.sol` reverts with short codes instead of sentences so the module stays under the
EIP-170 size limit (24,576 bytes) with lender protection included. The code is the revert reason
string; Etherscan and wallets show it as, for example, `MM23`. Codes are stable: a new reason gets the
next number, and a removed one is not reused.

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| MM01 | REENTRANCY                                      |
| MM02 | Oracle has no code                              |
| MM03 | Unsupported oracle                              |
| MM04 | Order has active positions                      |
| MM05 | Order needs a collateral                        |
| MM06 | Order is expired                                |
| MM07 | Not position owner                              |
| MM08 | Insufficient order balance                      |
| MM09 | Deposit must exceed zero                        |
| MM10 | Orders whitelist is empty                       |
| MM11 | Collaterals error                               |
| MM12 | Minloan error                                   |
| MM13 | Balance error                                   |
| MM14 | Collateral error                                |
| MM15 | Leverage error                                  |
| MM16 | ETH reception error                             |
| MM17 | ETH reward reception error                      |
| MM18 | Excess ETH                                      |
| MM19 | Position opens liquidatable                     |
| MM20 | Swap makes position liquidatable                |
| MM21 | Too little received                             |
| MM22 | Position is closed                              |
| MM23 | Not liquidatable                                |
| MM24 | Freeze and liquidate: same block                |
| MM25 | Asset not found in position                     |
| MM26 | Not frozen                                      |
| MM27 | Liquidatable                                    |
| MM28 | Position is not open                            |
| MM29 | Not authorized to close                         |
| MM30 | Subject to liquidation                          |
| MM31 | Insufficient funds to close                     |
| MM32 | Position still open                             |
| MM33 | No balance to withdraw                          |
| MM34 | ERC20 transfer failed                           |
| MM35 | No ERC223 deposit                               |
| MM36 | Order has active positions (maintenance margin) |
| MM37 | Maintenance margin out of range                 |
| MM38 | Lender-only window: loss liquidation            |

`MM36`-`MM38` were added with `orderSetLenderProtection`: a per-order maintenance margin
(`orderMaintenanceMarginBps`, 0 = the default 10%, else 10-50%, only changeable while the order has no
open positions) and a keeper (`orderLiquidationKeeper`). Once a position is worth less than its debt
(`positionUnderwaterSince` is set by `liquidate()`), only the lender or its keeper may complete the
liquidation for 24 hours; inside the 10% buffer and after the window, anyone may.
