import { blockchainTests, constants, expect } from '@0x/contracts-test-utils';
import { BigNumber, hexUtils } from '@0x/utils';

import { artifacts } from './artifacts';
import { TestFixinProtocolFeesContract, TestStakingContract, TestWethContract } from './wrappers';

blockchainTests.resets('ProtocolFees', env => {
    const FEE_MULTIPLIER = 70e3;
    let taker: string;
    let protocolFees: TestFixinProtocolFeesContract;
    let staking: TestStakingContract;
    let weth: TestWethContract;

    before(async () => {
        [taker] = await env.getAccountAddressesAsync();
        weth = await TestWethContract.deployFrom0xArtifactAsync(
            artifacts.TestWeth,
            env.provider,
            env.txDefaults,
            artifacts,
        );
        staking = await TestStakingContract.deployFrom0xArtifactAsync(
            artifacts.TestStaking,
            env.provider,
            env.txDefaults,
            artifacts,
            weth.address,
        );
        protocolFees = await TestFixinProtocolFeesContract.deployFrom0xArtifactAsync(
            artifacts.TestFixinProtocolFees,
            env.provider,
            env.txDefaults,
            artifacts,
            weth.address,
            staking.address,
            FEE_MULTIPLIER,
        );
        await weth.mint(taker, constants.ONE_ETHER).awaitTransactionSuccessAsync();
        await weth.approve(protocolFees.address, constants.ONE_ETHER).awaitTransactionSuccessAsync({ from: taker });
    });

    describe('_collectProtocolFee()', () => {
        let singleFeeAmount: BigNumber;

        before(async () => {
            singleFeeAmount = await protocolFees.getSingleProtocolFee().callAsync();
        });

        it('can collect a protocol fee multiple times', async () => {
            const poolId = hexUtils.random();

            // Transfer one fee via WETH.
            await protocolFees.collectProtocolFee(poolId, taker).awaitTransactionSuccessAsync();

            // Send to staking contract.
            await protocolFees.transferFeesForPool(poolId).awaitTransactionSuccessAsync();

            // Transfer the other fee via ETH.
            await protocolFees
                .collectProtocolFee(poolId, taker)
                .awaitTransactionSuccessAsync({ from: taker, value: singleFeeAmount });

            // Send to staking contract again.
            await protocolFees.transferFeesForPool(poolId).awaitTransactionSuccessAsync();

            const balance = await staking.balanceForPool(poolId).callAsync();
            const wethBalance = await weth.balanceOf(staking.address).callAsync();

            // Check that staking accounted for the collected ether properly.
            expect(balance).to.bignumber.eq(wethBalance);

            // We leave 1 wei behind, of both ETH and WETH, for gas reasons.
            const total = singleFeeAmount.times(2).minus(2);
            return expect(balance).to.bignumber.eq(total);
        });
    });
});
