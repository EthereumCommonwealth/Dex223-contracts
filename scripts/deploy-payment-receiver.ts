/**
 * Deploy Safe Send contracts (PaymentReceiver + SafeSendRouter).
 *
 *   npx hardhat run scripts/deploy-payment-receiver.ts --network sepolia
 *
 * Optional:
 *   PAYOUT=0x...           (defaults to deployer)
 *   CONVERTER=0x...        (defaults to known Sepolia / mainnet converter)
 */
import { ethers, network } from 'hardhat'

const CONVERTERS: Record<string, string> = {
  sepolia: '0x5847f5C0E09182d9e75fE8B1617786F62fee0D9F',
  mainnet: '0xe7E969012557f25bECddB717A3aa2f4789ba9f9a',
}

async function main() {
  const [deployer] = await ethers.getSigners()
  const payout = process.env.PAYOUT || (await deployer.getAddress())
  const converter =
    process.env.CONVERTER || CONVERTERS[network.name] || CONVERTERS.sepolia

  console.log(`Safe Send deploy -> ${network.name}`)
  console.log(`deployer  ${await deployer.getAddress()}`)
  console.log(`payout    ${payout}`)
  console.log(`converter ${converter}`)

  const Receiver = await ethers.getContractFactory('PaymentReceiver')
  const receiver = await Receiver.deploy(payout)
  await receiver.waitForDeployment()
  const receiverAddr = await receiver.getAddress()

  const Router = await ethers.getContractFactory('SafeSendRouter')
  const router = await Router.deploy(converter)
  await router.waitForDeployment()
  const routerAddr = await router.getAddress()

  console.log(`PaymentReceiver ${receiverAddr}`)
  console.log(`SafeSendRouter  ${routerAddr}`)
  console.log(`Update PAYMENT_RECEIVER and SAFE_SEND_ROUTER in Dex223-UI`)
  console.log(`apps/web/app/[locale]/send/config.ts to these addresses.`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
