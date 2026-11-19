/**
 * Hands a Dex223 factory and its autolistings to the protocol Safe (bounties #37 and #152): factory.setOwner(safe)
 * and autolisting.transferOwnership(safe), sent by the current owner.
 *
 * Dex223Factory.setOwner and the autolistings' transferOwnership are ONE step with no acceptance, so a wrong
 * address loses those admin rights for good. Before sending anything this script proves the target is the
 * intended Safe:
 *   - it has code, and its singleton (proxy storage slot 0) is a canonical Safe v1.4.1 singleton;
 *   - VERSION() is 1.4.1;
 *   - getOwners() is exactly OWNERS (order ignored) and getThreshold() is THRESHOLD;
 *   - no module is enabled and no guard is set, so nothing can act for the Safe without THRESHOLD signatures;
 * and that the sender owns every contract it is about to move. Afterwards it reads each owner back.
 *
 * Rehearsal on a local anvil fork (no key; the owner is impersonated). Without SAFE, a stand-in Safe is created
 * with OWNERS (or four random owners), and the run also proves, for every contract moved, that the Safe can act
 * (a no-op ownership call with THRESHOLD approvals; THRESHOLD - 1 is refused) and that the old owner is locked out:
 *   ~/.foundry/bin/anvil --fork-url https://ethereum-rpc.publicnode.com --chain-id 1 --port 8546
 *   [SAFE=0x..] OWNERS=0x..,0x..,0x..,0x.. npx hardhat run scripts/handover-factory-to-safe.ts --network fork
 *
 * Live (irreversible; the owner's key as PRIVATE_KEY):
 *   SAFE=0x.. OWNERS=0x..,0x..,0x..,0x.. CONFIRM_HANDOVER=<factory>+<n>autolistings-to-<safe> \
 *     npx hardhat run scripts/handover-factory-to-safe.ts --network mainnet
 *
 * FACTORY defaults to the mainnet factory the app uses (v2, 0x8990…C3a5). AUTOLISTINGS (comma-separated, or
 * "none") defaults to that factory's core and free autolistings (0x6305…0E5b, 0xB442…76d9) when FACTORY is the
 * default, and to none otherwise. THRESHOLD defaults to 3.
 */
import { ethers, network } from "hardhat";
import { mined } from "./tx-wait";

const DEFAULT_FACTORY = "0x899097B427cd04e1BD07FD3445cc90493300C3a5";
// deployments/mainnet-v2.json: coreAutolisting, freeAutolisting (both bound to DEFAULT_FACTORY).
const DEFAULT_AUTOLISTINGS = [
  "0x63054Fa5899Bce903E676CC478811bF1fed20E5b",
  "0xB442f1362163b168cebAd877067D35Eb8d9176d9",
];
// Safe ModuleManager sentinel and GuardManager storage slot (keccak256("guard_manager.guard.address")).
const SENTINEL_MODULES = "0x0000000000000000000000000000000000000001";
const GUARD_SLOT =
  "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
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
  "function getModulesPaginated(address,uint256) view returns (address[],address)",
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
const AUTOLISTING_ABI = [
  "function owner() view returns (address)",
  "function getFactory() view returns (address)",
  "function transferOwnership(address)",
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

  const autolistingsEnv = (process.env.AUTOLISTINGS || "").trim();
  const autolistingAddrs =
    autolistingsEnv.toLowerCase() === "none"
      ? []
      : autolistingsEnv
        ? autolistingsEnv
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((a) => ethers.getAddress(a))
        : eq(factoryAddr, DEFAULT_FACTORY)
          ? DEFAULT_AUTOLISTINGS
          : [];
  const autolistings: { addr: string; c: any; owner: string }[] = [];
  for (const addr of autolistingAddrs) {
    const c = new ethers.Contract(addr, AUTOLISTING_ABI, rpc);
    const bound: string = await c.getFactory();
    if (!eq(bound, factoryAddr))
      fail(
        `autolisting ${addr} is bound to factory ${bound}, not ${factoryAddr}`,
      );
    const owner: string = await c.owner();
    autolistings.push({ addr, c, owner });
    console.log(`autolisting ${addr} owner ${owner}`);
  }

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

  // Every contract not yet held by the Safe must have one and the same owner: the sender.
  let safeAddr = process.env.SAFE ? ethers.getAddress(process.env.SAFE) : "";
  const pendingOwners = [
    currentOwner,
    ...autolistings.map((a) => a.owner),
  ].filter((o) => !eq(o, safeAddr));
  if (new Set(pendingOwners.map((o) => o.toLowerCase())).size > 1)
    fail(
      `the contracts to move have different owners: ${pendingOwners.join(", ")}`,
    );
  const fromOwner = pendingOwners[0] ?? currentOwner;

  // The sender: that owner (impersonated on a fork, the configured key live).
  let sender: any;
  if (rehearsal) sender = await signerFor(fromOwner);
  else {
    sender =
      (await ethers.getSigners())[0] ??
      fail("no PRIVATE_KEY configured for this network");
    sender = sender.connect(rpc);
  }
  const senderAddr: string = await sender.getAddress();
  if (pendingOwners.length && !eq(senderAddr, fromOwner))
    fail(`sender ${senderAddr} is not the owner ${fromOwner}`);

  // The Safe: given, or (rehearsal only) a stand-in created with OWNERS.
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
  // A module or a guard could act for the Safe (or block it) without THRESHOLD signatures.
  const [modules]: [string[]] = await safe.getModulesPaginated(
    SENTINEL_MODULES,
    10,
  );
  if (modules.length) fail(`Safe has modules enabled: ${modules.join(",")}`);
  const guard = await rpc.getStorage(safeAddr, GUARD_SLOT);
  if (BigInt(guard) !== 0n) fail(`Safe has a guard set (${guard})`);
  console.log(
    `Safe ${safeAddr}: v${version}, ${got.length} owners, threshold ${th}, singleton ${singleton}, no modules, no guard`,
  );

  // What moves: the factory (setOwner) and each autolisting (transferOwnership), skipping any the Safe holds.
  const factoryIface = new ethers.Interface(FACTORY_ABI);
  const autoIface = new ethers.Interface(AUTOLISTING_ABI);
  const targets = [
    {
      label: `factory ${factoryAddr}`,
      addr: factoryAddr,
      owner: currentOwner,
      read: () => factory.owner() as Promise<string>,
      data: (to: string) => factoryIface.encodeFunctionData("setOwner", [to]),
    },
    ...autolistings.map((a) => ({
      label: `autolisting ${a.addr}`,
      addr: a.addr,
      owner: a.owner,
      read: () => a.c.owner() as Promise<string>,
      data: (to: string) =>
        autoIface.encodeFunctionData("transferOwnership", [to]),
    })),
  ];
  const todo = targets.filter((t) => !eq(t.owner, safeAddr));
  for (const t of targets)
    console.log(`  ${eq(t.owner, safeAddr) ? "held " : "move "} ${t.label}`);
  if (!todo.length) {
    console.log("the Safe already owns everything; nothing to send");
    return;
  }

  if (!rehearsal) {
    const n = autolistings.length;
    const expected =
      `${factoryAddr}${n ? `+${n}autolistings` : ""}-to-${safeAddr}`.toLowerCase();
    if ((process.env.CONFIRM_HANDOVER || "").toLowerCase() !== expected)
      fail(`irreversible: re-run with CONFIRM_HANDOVER=${expected}`);
  }
  for (const t of todo) {
    await send(
      `${t.label}: owner -> ${safeAddr}`,
      sender.sendTransaction({ to: t.addr, data: t.data(safeAddr) }),
    );
    const after: string = await t.read();
    if (!eq(after, safeAddr))
      fail(`${t.label}: owner after handover is ${after}`);
  }
  console.log(`  ok    the Safe owns every contract listed`);

  if (rehearsal) {
    const execSafe = async (
      to: string,
      data: string,
      label: string,
      approvers: string[],
      expectFail: boolean,
    ) => {
      const nonce = await safe.nonce();
      const hash: string = await safe.getTransactionHash(
        to,
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
        to,
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
            `  ok    ${label}: ${approvers.length} of ${owners.length} approvals are refused`,
          );
          return;
        }
        fail(`${label}: ${approvers.length} approvals executed`);
      }
      await send(
        `${label}: the Safe acts with ${approvers.length} of ${owners.length} approvals`,
        (safe.connect(sender) as any).execTransaction(...args),
      );
    };
    for (const t of todo) {
      // The old owner is locked out.
      try {
        await rpc.call({
          from: fromOwner,
          to: t.addr,
          data: t.data(fromOwner),
        });
        fail(`${t.label}: the old owner can still act`);
      } catch (e: any) {
        if (/old owner can still act/.test(e.message)) throw e;
        console.log(`  ok    ${t.label}: the old owner is refused`);
      }
      // The Safe can act: a no-op ownership call to itself, refused with threshold - 1 approvals.
      await execSafe(
        t.addr,
        t.data(safeAddr),
        t.label,
        owners.slice(0, threshold - 1),
        true,
      );
      await execSafe(
        t.addr,
        t.data(safeAddr),
        t.label,
        owners.slice(0, threshold),
        false,
      );
      if (!eq(await t.read(), safeAddr))
        fail(`${t.label}: owner changed during the Safe check`);
    }
  }
  console.log("\nDONE");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
