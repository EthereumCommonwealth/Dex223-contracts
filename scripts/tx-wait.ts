import { ethers } from 'ethers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/// Waits for `hash` to be mined with `confirmations`, polling the receipt itself. ethers' tx.wait() hung for
/// good in rehearsals (mined, receipt never seen), so every poll here is bounded and simply retried.
/// Throws if the transaction reverted, and after 30 minutes without a receipt; re-running resumes from chain state.
export async function mined(provider: ethers.Provider, hash: string, confirmations = 1): Promise<ethers.TransactionReceipt> {
  const bounded = <T>(p: Promise<T>) => Promise.race([p, sleep(20_000).then((): never => { throw new Error('rpc timeout') })])
  for (let i = 0; i < 600; i++) {
    let r: ethers.TransactionReceipt | null = null
    try {
      r = await bounded(provider.getTransactionReceipt(hash))
      if (r && (await bounded(provider.getBlockNumber())) - r.blockNumber + 1 < confirmations) r = null
    } catch { r = null }
    if (r) {
      if (r.status !== 1) throw new Error(`${hash} reverted`)
      return r
    }
    await sleep(3000)
  }
  throw new Error(`${hash} not seen mined after 30 minutes; check it on the explorer, then re-run to resume`)
}
