/**
 * Hands a Dex223 factory to the protocol Safe (bounty #37): factory.setOwner(safe), sent by the current owner.
 *
 * Dex223Factory.setOwner is ONE step with no acceptance, so a wrong address loses the factory's admin rights for
 * good. Before sending anything this script proves the target is the intended Safe:
 *   - it has code, and its singleton (proxy storage slot 0) is a canonical Safe v1.4.1 singleton;
 *   - VERSION() is 1.4.1;
 *   - getOwners() is exactly OWNERS (order ignored) and getThreshold() is THRESHOLD;
 * and that the sender is the factory's current owner. Afterwards it reads the owner back.
 *
 * Rehearsal on a local anvil fork (no key; the owner is impersonated). Without SAFE, a stand-in Safe is created
 * with OWNERS (or four random owners), and the run also proves the Safe can act (a no-op setOwner(safe) with
 * THRESHOLD approvals; THRESHOLD - 1 is refused) and that the old owner is locked out:
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-rpc.publicnode.com --chain-id 1 --port 8546
 *   [SAFE=0x..] OWNERS=0x..,0x..,0x..,0x.. npx hardhat run scripts/handover-factory-to-safe.ts --network fork
 *
 * Live (irreversible; the factory owner's key as PRIVATE_KEY):
 *   SAFE=0x.. OWNERS=0x..,0x..,0x..,0x.. CONFIRM_HANDOVER=<factory>-to-<safe> \
 *     npx hardhat run scripts/handover-factory-to-safe.ts --network mainnet
 *
 * FACTORY defaults to the mainnet factory the app uses (v2, 0x8990…C3a5). THRESHOLD defaults to 3.
 */
import { ethers, network } from "hardhat";
import { mined } from "./tx-wait";

const DEFAULT_FACTORY = "0x899097B427cd04e1BD07FD3445cc90493300C3a5";
// Canonical Safe v1.4.1 deployments (same addresses on every chain).
const SAFE_SINGLETONS = [
  "0x41675C099F32341bf84BFc5382aF534df5C7461a", // Safe 1.4.1
  "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", // SafeL2 1.4.1
];
const SAFE_PROXY_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const FALLBACK_HANDLER = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";
const SAFE = [
  "function setup(address[],uint256,address,bytes,address,address,uint256,address)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
  "function approveHash(bytes32)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)",
];
const PROXY_FACTORY = [
  "function createProxyWithNonce(address,bytes,uint256) returns (address)",
  "event ProxyCreation(address indexed proxy, address singleton)",
];
const FACTORY_ABI = [
  "function owner() view returns (address)",
  "function setOwner(address)",
];

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const fail = (msg: string): never => {
  throw new Error(msg);
};

async function main() {
  const rpc = new ethers.JsonRpcProvider(
    (network.config as any).url,
    undefined,
    { staticNetwork: true },
  );
  const client: string = await rpc
    .send("web3_clientVersion", [])
    .catch(() => "");
  const rehearsal = /anvil/i.test(client);
  const factoryAddr = ethers.getAddress(process.env.FACTORY || DEFAULT_FACTORY);
  const threshold = Number(process.env.THRESHOLD || 3);
  const send = async (label: string, p: Promise<any>) => {
    const tx = await p;
    const r = await mined(rpc, tx.hash);
    if (r.status !== 1) fail(`${label}: reverted (${tx.hash})`);
    console.log(`  ok    ${label}  ${tx.hash}`);
    return r;
  };
  const signerFor = async (a: string) => {
    await rpc.send("anvil_impersonateAccount", [a]);
    await rpc.send("anvil_setBalance", [a, "0x8AC7230489E80000"]);
    return rpc.getSigner(a);
  };

  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, rpc);
  const currentOwner: string = await factory.owner();
  console.log(
    `factory ${factoryAddr} on chain ${(await rpc.getNetwork()).chainId} (${rehearsal ? "anvil rehearsal" : "LIVE"})`,
  );
  console.log(`current owner ${currentOwner}`);

  let owners = (process.env.OWNERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => ethers.getAddress(a));
  if (!owners.length) {
    if (!rehearsal) fail("set OWNERS to the Safe signers (comma-separated)");
    owners = Array.from(
      { length: 4 },
      () => ethers.Wallet.createRandom().address,
    );
  }
  if (new Set(owners.map((o) => o.toLowerCase())).size !== owners.length)
    fail("OWNERS has duplicates");
  if (threshold < 2 || threshold > owners.length)
    fail(`THRESHOLD ${threshold} does not fit ${owners.length} owners`);

  // The sender: the factory owner (impersonated on a fork, the configured key live).
  let sender: any;
  if (rehearsal) sender = await signerFor(currentOwner);
  else {
    sender =
      (await ethers.getSigners())[0] ??
      fail("no PRIVATE_KEY configured for this network");
    sender = sender.connect(rpc);
  }
  if (!eq(await sender.getAddress(), currentOwner))
    fail(
      `sender ${await sender.getAddress()} is not the factory owner ${currentOwner}`,
    );

  // The Safe: given, or (rehearsal only) a stand-in created with OWNERS.
  let safeAddr = process.env.SAFE ? ethers.getAddress(process.env.SAFE) : "";
  if (!safeAddr) {
    if (!rehearsal) fail("set SAFE to the protocol Safe address");
    const iface = new ethers.Interface(SAFE);
    const init = iface.encodeFunctionData("setup", [
      owners,
      threshold,
      ethers.ZeroAddress,
      "0x",
      FALLBACK_HANDLER,
      ethers.ZeroAddress,
      0,
      ethers.ZeroAddress,
    ]);
    const pf = new ethers.Contract(SAFE_PROXY_FACTORY, PROXY_FACTORY, sender);
    const r = await send(
      "create stand-in Safe (rehearsal)",
      pf.createProxyWithNonce(SAFE_SINGLETONS[0], init, BigInt(Date.now())),
    );
    const ev = r.logs
      .map((l: any) => {
        try {
          return pf.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((x: any) => x?.name === "ProxyCreation");
    safeAddr = ethers.getAddress(
      ev?.args.proxy ?? fail("no ProxyCreation event"),
    );
  }

  // Prove the target is the intended Safe before the one-step, irreversible setOwner.
  const safe = new ethers.Contract(safeAddr, SAFE, rpc);
  if ((await rpc.getCode(safeAddr)) === "0x") fail(`${safeAddr} has no code`);
  const singleton = ethers.getAddress(
    "0x" + (await rpc.getStorage(safeAddr, 0)).slice(26),
  );
  if (!SAFE_SINGLETONS.some((s) => eq(s, singleton)))
    fail(
      `${safeAddr} is not a canonical Safe v1.4.1 proxy (singleton ${singleton})`,
    );
  const version: string = await safe.VERSION();
  if (version !== "1.4.1") fail(`Safe VERSION ${version}, expected 1.4.1`);
  const got: string[] = await safe.getOwners();
  if (
    got.length !== owners.length ||
    !owners.every((o) => got.some((g) => eq(g, o)))
  )
    fail(`Safe owners ${got.join(",")} differ from OWNERS`);
  const th = Number(await safe.getThreshold());
  if (th !== threshold) fail(`Safe threshold ${th}, expected ${threshold}`);
  console.log(
    `Safe ${safeAddr}: v${version}, ${got.length} owners, threshold ${th}, singleton ${singleton}`,
  );
  if (eq(currentOwner, safeAddr)) {
    console.log("the Safe already owns the factory; nothing to send");
    return;
  }

  if (!rehearsal) {
    const expected = `${factoryAddr}-to-${safeAddr}`.toLowerCase();
    if ((process.env.CONFIRM_HANDOVER || "").toLowerCase() !== expected)
      fail(`irreversible: re-run with CONFIRM_HANDOVER=${expected}`);
  }
  await send(
    `factory.setOwner(${safeAddr})`,
    (factory.connect(sender) as any).setOwner(safeAddr),
  );
  const after: string = await factory.owner();
  if (!eq(after, safeAddr)) fail(`owner after handover is ${after}`);
  console.log(`  ok    factory owner is now the Safe`);

  if (rehearsal) {
    // The old owner is locked out.
    try {
      await (factory.connect(sender) as any).setOwner.staticCall(currentOwner);
      fail("the old owner can still act");
    } catch (e: any) {
      if (/old owner can still act/.test(e.message)) throw e;
      console.log("  ok    the old owner is refused");
    }
    // The Safe can act: a no-op setOwner(safe), refused with threshold - 1 approvals, executed with threshold.
    const data = new ethers.Interface(FACTORY_ABI).encodeFunctionData(
      "setOwner",
      [safeAddr],
    );
    const execSafe = async (approvers: string[], expectFail: boolean) => {
      const nonce = await safe.nonce();
      const hash: string = await safe.getTransactionHash(
        factoryAddr,
        0,
        data,
        0,
        0,
        0,
        0,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        nonce,
      );
      for (const a of approvers)
        await mined(
          rpc,
          (await (safe.connect(await signerFor(a)) as any).approveHash(hash))
            .hash,
        );
      const sigs =
        "0x" +
        [...approvers]
          .sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
          .map(
            (a) => ethers.zeroPadValue(a, 32).slice(2) + "00".repeat(32) + "01",
          )
          .join("");
      const args = [
        factoryAddr,
        0,
        data,
        0,
        0,
        0,
        0,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        sigs,
      ] as const;
      if (expectFail) {
        try {
          await (safe.connect(sender) as any).execTransaction.staticCall(
            ...args,
          );
        } catch {
          console.log(
            `  ok    ${approvers.length} of ${owners.length} approvals are refused`,
          );
          return;
        }
        fail(`${approvers.length} approvals executed`);
      }
      await send(
        `Safe acts on the factory with ${approvers.length} of ${owners.length} approvals`,
        (safe.connect(sender) as any).execTransaction(...args),
      );
    };
    await execSafe(owners.slice(0, threshold - 1), true);
    await execSafe(owners.slice(0, threshold), false);
    if (!eq(await factory.owner(), safeAddr))
      fail("owner changed during the Safe check");
  }
  console.log("\nDONE");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
