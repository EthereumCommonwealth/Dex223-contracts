# DEX223 fee keeper (AWS Lambda)

Runs daily in the RORO AWS account (680302448261, us-east-1). For mainnet and Sepolia it:
1. switches protocol fees on in new pools;
2. collects accrued protocol fees into RevenueV2;
3. calls `syncAll()` so collected fees start streaming to stakers.

It is the scheduled form of `scripts/fee-keeper.ts`. Without it, fees sit in the pools or in RevenueV2 and are never paid out.

Every call it makes is permissionless. The keeper wallet only needs ETH for gas. The RevenueV2 and collector owner keys are never used.

## Pieces

| Resource | Name |
|---|---|
| Lambda (Node 22) | `dex223-fee-keeper` |
| Schedule (EventBridge) | `dex223-fee-keeper-daily`, 06:00 UTC |
| Secret (Secrets Manager) | `dex223/fee-keeper`: `{"privateKey": "0x…", "etherscanApiKey": "…"}` |
| IAM role | `dex223-fee-keeper-role`: logs, read that one secret, write `DEX223/FeeKeeper` metrics |
| Alerts (SNS → email) | `dex223-fee-keeper-alerts`, to rroland1@yahoo.com (`ALERT_EMAIL` in `deploy.sh`) |
| Alarms | `-failed` (a run threw), `-mainnet-gas-low` (< 0.005 ETH), `-sepolia-gas-low` (< 0.001 ETH), `-not-running` (no run in 2 days) |

## Current deployment (2026-10-07)

- **Keeper wallet:** `0x97cEa1642F6896dDcAe2062087a8C34651D2a10C`. Funded with 0.02 ETH on mainnet and 0.1 ETH on Sepolia.
- **Sepolia top-ups:** 0.1 Sepolia ETH covers about 50,000 runs, at roughly 0.000002 ETH each. If `-sepolia-gas-low` fires, top up from the Dex223 Sepolia bot account `0x389e7b207a77ca4ad4bB61D56fC05461a6f20787` (1Password vault "Dex223 Bot Accounts (Sepolia)").
- **Where the key is:**
  - 1Password, vault "Dex223 — Production", item "DEX223 fee keeper wallet" (the key is in the `password` field).
  - AWS Secrets Manager, `dex223/fee-keeper`, together with the Etherscan API key.
- **First run:**
  - Sepolia: collected protocol fees from 3 pools and started WETH, USDC, USDT and D223 reward streams.
  - Mainnet: nothing to do, because there are no pools yet.

## Setup

1. **Create the secret.** This generates a fresh wallet, combines it with the Etherscan API key from the contracts `.env`, and pipes both into Secrets Manager without printing either. It prints only the new address:

   ```
   set -a; . ../Dex223_Contracts/.env; set +a
   NODE_PATH=$PWD/node_modules node -e "const w=require('ethers').Wallet.createRandom();process.stdout.write(JSON.stringify({privateKey:w.privateKey,etherscanApiKey:process.env.ETHERSCAN_API_KEY}));process.stderr.write('keeper address '+w.address+'\n')" \
     | aws secretsmanager create-secret --name dex223/fee-keeper --secret-string file:///dev/stdin --query ARN --output text
   ```

2. **Fund the address.** Send about 0.02 ETH on mainnet and a little Sepolia ETH.

3. **Deploy:** run `ops/fee-keeper-lambda/deploy.sh`. Confirm the SNS email so alerts arrive.

4. **Dry run:**

   ```
   aws lambda invoke --function-name dex223-fee-keeper --payload '{"dryRun":true}' --cli-binary-format raw-in-base64-out /dev/stdout
   ```

To change code or settings, edit `index.mjs` and re-run `deploy.sh`. Logs are in CloudWatch under `/aws/lambda/dex223-fee-keeper`.

## Behaviour

- **Pool list:** read from the Etherscan v2 logs API. None of the free RPCs tried serve `eth_getLogs` back to the factory block.
- **Mainnet gas cap:** mainnet is skipped on days the base fee is above 20 gwei (`MAINNET_MAX_BASE_FEE_GWEI`). Fees keep accruing, and each batch streams over a week, so a skipped day costs stakers nothing.
- **Sepolia gas price:** pinned at 0.001 gwei, because Sepolia's suggested fee is far above what blocks actually need.
- **Idle days:** nothing is sent when there is nothing to do.
- **Failures:** a failed transaction or lookup on any network fails the run and raises the `-failed` alarm.
