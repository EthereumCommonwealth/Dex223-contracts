import { Wallet } from 'ethers'
import { ethers } from 'hardhat'
import { AutoListingsRegistry, Dex223AutoListing, TestERC20 } from '../typechain-types/'
import { Dex223Factory } from '../typechain-types/'
import { TokenStandardConverter } from '../typechain-types/'
import { expect } from 'chai'

import { listingFixture } from './shared/fixtures'

import { FeeAmount } from './shared/utilities'
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const feeAmount = FeeAmount.MEDIUM

describe('AutoListing', () => {
    let wallet: Wallet, other: Wallet

    let token0: TestERC20
    let token1: TestERC20
    let token2: TestERC20
    let token3: string
    let token4: string
    let token5: string
    let factory: Dex223Factory
    let converter: TokenStandardConverter
    let pool0: string
    let pool1: string

    let registry: AutoListingsRegistry
    let listing: Dex223AutoListing

    before('create fixture loader', async () => {
        ;[wallet, other] = await (ethers as any).getSigners()
    })

    beforeEach('deploy first fixture', async () => {
        ;({ token0, token1, token2, registry, listing, factory, converter } = await loadFixture(listingFixture));

        token3 = await converter.predictWrapperAddress(token0.target, true);
        token4 = await converter.predictWrapperAddress(token1.target, true);
        token5 = await converter.predictWrapperAddress(token2.target, true);

        await factory.createPool(
            token0.target.toString(), token1.target.toString(),
            token3, token4,
            feeAmount
        );

        await factory.createPool(
            token1.target.toString(), token2.target.toString(),
            token4, token5,
            feeAmount
        );

        pool0 = await factory.getPool(token0, token1, feeAmount);
        pool1 = await factory.getPool(token1, token2, feeAmount);

    })

    it('constructor initializes immutables', async () => {
        expect(await listing.getRegistry()).to.eq(registry.target.toString())
        expect(await listing.getFactory()).to.eq(factory.target.toString())
    })

    describe('lists add', () => {

        it('add list', async () => {
            // NOTE list with payment
            await expect(listing.list(pool0, feeAmount, pool0))
                .to.emit(registry, 'TokenListed')
                .withArgs(listing.target.toString(), token0.target.toString(), token3)
                .to.emit(listing, 'TokenListed')
                .to.emit(registry, 'TokenListed')
                .withArgs(listing.target.toString(), token1.target.toString(), token4)
                .to.emit(listing, 'TokenListed')
                .to.emit(listing, 'PairListed')
                .withArgs(token0.target.toString(), token3, token1.target.toString(), token4, pool0, feeAmount);

            expect(await listing.name()).to.eq('AutoTest listing');
            expect(await listing.url()).to.eq('none');
            expect(await listing.isListed(token0.target.toString())).to.eq(true);
            expect(await listing.isListed(token1.target.toString())).to.eq(true);

            expect(await listing.isListed(token2.target.toString())).not.to.eq(true);
            expect(await listing.isListed(token5)).not.to.eq(true);

            await expect(listing.list(pool0, feeAmount, pool0 ))
                .not.to.emit(registry, 'TokenListed')
                .not.to.emit(listing, 'TokenListed')
                .not.to.emit(listing, 'TokenListed');
                // .withArgs(pool1.target.toString(), wallet.address, 100n)

            await expect(listing.list(pool1, feeAmount, pool1))
                .to.emit(registry, 'TokenListed')
                .to.emit(listing, 'TokenListed')
                .to.emit(listing, 'PairListed');

            expect(await listing.isListed(token0.target.toString())).to.eq(true);
            expect(await listing.isListed(token1.target.toString())).to.eq(true);
            expect(await listing.isListed(token2.target.toString())).to.eq(true);
            expect(await listing.isListed(token3)).to.eq(true);
            expect(await listing.isListed(token4)).to.eq(true);
            expect(await listing.isListed(token5)).to.eq(true);

            expect(await listing.getToken(1)).to.deep.eq([token0.target.toString(), token3]);
            expect(await listing.getToken(2)).to.deep.eq([token1.target.toString(), token4]);
            expect(await listing.getToken(3)).to.deep.eq([token2.target.toString(), token5]);

        })

    })

    // An ERC-223 origin (like D223) is listed with its converter-made ERC-20 wrapper. The converter's ERC-223
    // wrapper of that wrapper is a different, codeless address; it must never replace the origin in the listing.
    describe('listing pairs', () => {
        async function erc223Origin() {
            const origin = await (await ethers.getContractFactory('ERC223HybridToken')).deploy('origin', 'O', 18n)
            const w20 = await converter.predictWrapperAddress(origin.target, false)
            const wrapperOfWrapper = await converter.predictWrapperAddress(w20, true)
            return { origin: origin.target.toString(), w20, wrapperOfWrapper }
        }

        it('core listSingle refuses an ERC-20 wrapper or a codeless address as the ERC-20 origin', async () => {
            const core = await (await ethers.getContractFactory('Dex223CoreAutoListing'))
                .deploy(factory.target, registry.target, converter.target, 'core', 'https://core')
            const { origin, w20, wrapperOfWrapper } = await erc223Origin()

            // The ERC-20 wrapper does not exist yet: no code.
            await expect(core.listSingle(w20, wrapperOfWrapper, ethers.ZeroAddress)).to.be.revertedWith('Not an ERC-20 origin')

            await converter.createERC20Wrapper(origin)
            await expect(core.listSingle(w20, wrapperOfWrapper, ethers.ZeroAddress)).to.be.revertedWith('Not an ERC-20 origin')
            expect(await core.isListed(w20)).to.eq(false)

            // A real ERC-20 origin still lists with its ERC-223 wrapper.
            await core.listSingle(token0.target, token3, ethers.ZeroAddress)
            expect(await core.tokens(await core.listed_tokens(token0.target))).to.deep.eq([token0.target.toString(), token3])
        })

        it('an update never re-pairs a listed token, and a zero half leaves it as it is', async () => {
            // checkListing is shared by all three listings. The owner's listTokenByOwner passes any pair to it,
            // so the guard is tested here independently of how a contradicting pair might arrive (on the free
            // listing that was a pool squatting a wrapper address, which the validator now refuses).
            const ownable = await (await ethers.getContractFactory('Dex223OwnableListing'))
                .deploy(factory.target, registry.target, 'ownable', 'https://ownable')
            const { origin, w20, wrapperOfWrapper } = await erc223Origin()

            await ownable.listTokenByOwner(w20, origin)
            const id = await ownable.listed_tokens(w20)
            expect(await ownable.getToken(id)).to.deep.eq([w20, origin])

            await expect(ownable.listTokenByOwner(w20, wrapperOfWrapper)).to.be.revertedWith('Listing pair mismatch')
            await ownable.listTokenByOwner(w20, ethers.ZeroAddress)
            expect(await ownable.getToken(id)).to.deep.eq([w20, origin])
            expect(await ownable.isListed(wrapperOfWrapper)).to.eq(false)
        })
    })
})
