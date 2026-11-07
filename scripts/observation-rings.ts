/**
 * Checks, and on request grows, the observation ring of every pool a factory has created.
 *
 * Why: the margin oracle only prices a pool whose oldest observation is at least twapWindow (1800 s) old
 * (Dex223Oracle.poolCanServeWindow). A pool keeps the default ring of one slot until someone calls
 * increaseObservationCardinalityNext. With one slot, every swap through the pool overwrites its only
 * observation, so for the next twapWindow seconds the oracle refuses the pool: margin swaps revert in their
 * solvency check with "Oracle: no pool found", and positions priced through that pool cannot be valued or
 * liquidated. Seeded pools are grown by seed-sepolia-v3.ts; pools users create in the UI are not.
 *
 * Every pool used as margin collateral needs a grown ring before launch (and before lenders use it).
 * Growing is permissionless; it costs about 20k gas per new slot on mainnet (Sepolia charges ~7x).
 *
 * Report only (no key needed):
 *
 *   FACTORY=0x4EC06106Cf666A817586563ae042ffF8B76e3460 FROM_BLOCK=12026940 \
 *     npx hardhat run scripts/observation-rings.ts --network sepolia
 *
 * Grow every pool whose next cardinality is below CARDINALITY (default 50), or only the pools in POOLS
 * (with POOLS the factory's logs are not scanned, so FACTORY and FROM_BLOCK may be omitted):
 *
 *   GROW=1 RING_KEY=... POOLS=0xabc...,0xdef... FACTORY=... FROM_BLOCK=... \
 *     npx hardhat run scripts/observation-rings.ts --network sepolia
 *
 * A grown ring only fills as swaps write new observations, and the oracle still needs the oldest one to be
 * twapWindow old, so a pool is usable for margin about 30 minutes after its first observation, as before.
 */
import type { Provider } from "ethers";
import { ethers, network } from "hardhat";
import { mined } from "./tx-wait";

const fail = (msg: string): never => {
  throw new Error(msg);
};

const FACTORY_ABI = [
  "event PoolCreated(address indexed token0_erc20, address indexed token1_erc20, address token0_erc223, address token1_erc223, uint24 indexed fee, int24 tickSpacing, address pool)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function token0() view returns (address,address)",
  "function token1() view returns (address,address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function increaseObservationCardinalityNext(uint16)",
];
const ORACLE_ABI = ["function poolCanServeWindow(address) view returns (bool)"];

async function poolsOf(provider: Provider, factory: string, fromBlock: number) {
  const iface = new ethers.Interface(FACTORY_ABI);
  const topic = iface.getEvent("PoolCreated")!.topicHash;
  const latest = await provider.getBlockNumber();
  const step = Number(process.env.LOG_STEP || 45000);
  const pools: { pool: string; pair: string; fee: number }[] = [];
  for (let from = fromBlock; from <= latest; from += step) {
    const to = Math.min(from + step - 1, latest);
    for (const log of await provider.getLogs({
      address: factory,
      topics: [topic],
      fromBlock: from,
      toBlock: to,
    })) {
      const e = iface.parseLog(log)!;
      pools.push({
        pool: e.args.pool,
        pair: `${e.args.token0_erc20}/${e.args.token1_erc20}`,
        fee: Number(e.args.fee),
      });
    }
  }
  return pools;
}

async function main() {
  const url =
    (network.config as any).url || fail(`network '${network.name}' has no url`);
  const provider = new ethers.JsonRpcProvider(url, undefined, {
    staticNetwork: true,
  });
  const only = (process.env.POOLS || "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  const factory =
    process.env.FACTORY || (only.length ? "" : fail("set FACTORY"));
  const fromBlock = Number(
    process.env.FROM_BLOCK ||
      (only.length ? 0 : fail("set FROM_BLOCK (the factory deploy block)"))
  );
  const target = Number(process.env.CARDINALITY || 50);
  const oracle = process.env.ORACLE
    ? new ethers.Contract(process.env.ORACLE, ORACLE_ABI, provider)
    : null;

  // With POOLS, read just those pools: no log scan, which free RPCs prune or rate-limit.
  const pools = only.length
    ? await Promise.all(
        only.map(async (pool) => {
          const c = new ethers.Contract(pool, POOL_ABI, provider);
          const [[t0], [t1], fee] = await Promise.all([
            c.token0(),
            c.token1(),
            c.fee(),
          ]);
          return {
            pool: ethers.getAddress(pool),
            pair: `${t0}/${t1}`,
            fee: Number(fee),
          };
        })
      )
    : await poolsOf(provider, factory, fromBlock);
  console.log(
    `${pools.length} pool(s) ${
      only.length ? "given" : `from factory ${factory}`
    } on ${network.name}, target cardinality ${target}\n`
  );

  const small: string[] = [];
  for (const p of pools) {
    const c = new ethers.Contract(p.pool, POOL_ABI, provider);
    const [, , , card, next] = await c.slot0();
    const serves = oracle
      ? ` oracleOK=${await oracle.poolCanServeWindow(p.pool)}`
      : "";
    const flag = Number(next) < target ? "  << below target" : "";
    console.log(
      `${p.pool} fee ${p.fee} ${
        p.pair
      } cardinality ${card} next ${next} liquidity ${await c.liquidity()}${serves}${flag}`
    );
    if (Number(next) < target) small.push(p.pool);
  }

  if (process.env.GROW !== "1") {
    console.log(
      `\n${small.length} pool(s) below target. Re-run with GROW=1 RING_KEY=... to grow them.`
    );
    return;
  }
  const signer = new ethers.Wallet(
    process.env.RING_KEY || fail("GROW=1 needs RING_KEY"),
    provider
  );
  for (const pool of small) {
    const c = new ethers.Contract(pool, POOL_ABI, signer);
    // 20% over the estimate, as the other scripts do.
    const gas =
      ((await c.increaseObservationCardinalityNext.estimateGas(target)) *
        120n) /
      100n;
    const tx = await c.increaseObservationCardinalityNext(target, {
      gasLimit: gas,
    });
    const r = await mined(provider, tx.hash);
    console.log(`  grown  ${pool} -> ${target} ${tx.hash} gas ${r.gasUsed}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
