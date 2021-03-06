// tslint:disable: no-unbound-method
import { ChainId, getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import {
    assertRoughlyEquals,
    constants,
    expect,
    getRandomFloat,
    getRandomInteger,
    Numberish,
    randomAddress,
} from '@0x/contracts-test-utils';
import { assetDataUtils, generatePseudoRandomSalt } from '@0x/order-utils';
import { AssetProxyId, ERC20BridgeAssetData, SignedOrder } from '@0x/types';
import { BigNumber, hexUtils, NULL_ADDRESS } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import * as _ from 'lodash';
import * as TypeMoq from 'typemoq';

import { MarketOperation, QuoteRequestor, RfqtRequestOpts, SignedOrderWithFillableAmounts } from '../src';
import { PriceAwareRFQFlags } from '../src/types';
import { getRfqtIndicativeQuotesAsync, MarketOperationUtils } from '../src/utils/market_operation_utils/';
import { BalancerPoolsCache } from '../src/utils/market_operation_utils/balancer_utils';
import {
    BRIDGE_ADDRESSES_BY_CHAIN,
    BUY_SOURCE_FILTER,
    POSITIVE_INF,
    SELL_SOURCE_FILTER,
    SOURCE_FLAGS,
    ZERO_AMOUNT,
} from '../src/utils/market_operation_utils/constants';
import { CreamPoolsCache } from '../src/utils/market_operation_utils/cream_utils';
import { createFills } from '../src/utils/market_operation_utils/fills';
import { DexOrderSampler } from '../src/utils/market_operation_utils/sampler';
import { BATCH_SOURCE_FILTERS } from '../src/utils/market_operation_utils/sampler_operations';
import { SourceFilters } from '../src/utils/market_operation_utils/source_filters';
import {
    AggregationError,
    DexSample,
    ERC20BridgeSource,
    FillData,
    GenerateOptimizedOrdersOpts,
    GetMarketOrdersOpts,
    MarketSideLiquidity,
    NativeFillData,
    TokenAdjacencyGraph,
} from '../src/utils/market_operation_utils/types';

const MAKER_TOKEN = randomAddress();
const TAKER_TOKEN = randomAddress();
const MAKER_ASSET_DATA = assetDataUtils.encodeERC20AssetData(MAKER_TOKEN);
const TAKER_ASSET_DATA = assetDataUtils.encodeERC20AssetData(TAKER_TOKEN);
const DEFAULT_EXCLUDED = [
    ERC20BridgeSource.UniswapV2,
    ERC20BridgeSource.Curve,
    ERC20BridgeSource.Balancer,
    ERC20BridgeSource.MStable,
    ERC20BridgeSource.Mooniswap,
    ERC20BridgeSource.Bancor,
    ERC20BridgeSource.Swerve,
    ERC20BridgeSource.SnowSwap,
    ERC20BridgeSource.SushiSwap,
    ERC20BridgeSource.MultiHop,
    ERC20BridgeSource.Shell,
    ERC20BridgeSource.Cream,
    ERC20BridgeSource.Dodo,
    ERC20BridgeSource.LiquidityProvider,
];
const BUY_SOURCES = BUY_SOURCE_FILTER.sources;
const SELL_SOURCES = SELL_SOURCE_FILTER.sources;
const TOKEN_ADJACENCY_GRAPH: TokenAdjacencyGraph = { default: [] };
const PRICE_AWARE_RFQ_ENABLED: PriceAwareRFQFlags = {
    isFirmPriceAwareEnabled: true,
    isIndicativePriceAwareEnabled: true,
};

// tslint:disable: custom-no-magic-numbers promise-function-async
describe('MarketOperationUtils tests', () => {
    const CHAIN_ID = ChainId.Mainnet;
    const contractAddresses = {
        ...getContractAddressesForChainOrThrow(CHAIN_ID),
        ...BRIDGE_ADDRESSES_BY_CHAIN[CHAIN_ID],
    };

    function getMockedQuoteRequestor(
        type: 'indicative' | 'firm',
        results: SignedOrder[],
        verifiable: TypeMoq.Times,
    ): TypeMoq.IMock<QuoteRequestor> {
        const args: [any, any, any, any, any, any] = [
            TypeMoq.It.isAny(),
            TypeMoq.It.isAny(),
            TypeMoq.It.isAny(),
            TypeMoq.It.isAny(),
            TypeMoq.It.isAny(),
            TypeMoq.It.isAny(),
        ];
        const requestor = TypeMoq.Mock.ofType(QuoteRequestor, TypeMoq.MockBehavior.Loose, true);
        if (type === 'firm') {
            requestor
                .setup(r => r.requestRfqtFirmQuotesAsync(...args))
                .returns(async () => results.map(result => ({ signedOrder: result })))
                .verifiable(verifiable);
        } else {
            requestor
                .setup(r => r.requestRfqtIndicativeQuotesAsync(...args))
                .returns(async () => results)
                .verifiable(verifiable);
        }
        return requestor;
    }

    function createOrder(overrides?: Partial<SignedOrder>): SignedOrder {
        return {
            chainId: CHAIN_ID,
            exchangeAddress: contractAddresses.exchange,
            makerAddress: constants.NULL_ADDRESS,
            takerAddress: constants.NULL_ADDRESS,
            senderAddress: constants.NULL_ADDRESS,
            feeRecipientAddress: randomAddress(),
            salt: generatePseudoRandomSalt(),
            expirationTimeSeconds: getRandomInteger(0, 2 ** 64),
            makerAssetData: MAKER_ASSET_DATA,
            takerAssetData: TAKER_ASSET_DATA,
            makerFeeAssetData: constants.NULL_BYTES,
            takerFeeAssetData: constants.NULL_BYTES,
            makerAssetAmount: getRandomInteger(1, 1e18),
            takerAssetAmount: getRandomInteger(1, 1e18),
            makerFee: constants.ZERO_AMOUNT,
            takerFee: constants.ZERO_AMOUNT,
            signature: hexUtils.random(),
            ...overrides,
        };
    }

    function getSourceFromAssetData(assetData: string): ERC20BridgeSource {
        if (assetData.length === 74) {
            return ERC20BridgeSource.Native;
        }
        const bridgeData = assetDataUtils.decodeAssetDataOrThrow(assetData);
        if (!assetDataUtils.isERC20BridgeAssetData(bridgeData)) {
            throw new Error('AssetData is not ERC20BridgeAssetData');
        }
        const { bridgeAddress } = bridgeData;
        switch (bridgeAddress) {
            case contractAddresses.kyberBridge.toLowerCase():
                return ERC20BridgeSource.Kyber;
            case contractAddresses.eth2DaiBridge.toLowerCase():
                return ERC20BridgeSource.Eth2Dai;
            case contractAddresses.uniswapBridge.toLowerCase():
                return ERC20BridgeSource.Uniswap;
            case contractAddresses.uniswapV2Bridge.toLowerCase():
                return ERC20BridgeSource.UniswapV2;
            case contractAddresses.curveBridge.toLowerCase():
                return ERC20BridgeSource.Curve;
            case contractAddresses.mStableBridge.toLowerCase():
                return ERC20BridgeSource.MStable;
            case contractAddresses.mooniswapBridge.toLowerCase():
                return ERC20BridgeSource.Mooniswap;
            case contractAddresses.sushiswapBridge.toLowerCase():
                return ERC20BridgeSource.SushiSwap;
            case contractAddresses.shellBridge.toLowerCase():
                return ERC20BridgeSource.Shell;
            case contractAddresses.dodoBridge.toLowerCase():
                return ERC20BridgeSource.Dodo;
            default:
                break;
        }
        throw new Error(`Unknown bridge address: ${bridgeAddress}`);
    }

    function assertSamePrefix(actual: string, expected: string): void {
        expect(actual.substr(0, expected.length)).to.eq(expected);
    }

    function createOrdersFromSellRates(takerAssetAmount: BigNumber, rates: Numberish[]): SignedOrder[] {
        const singleTakerAssetAmount = takerAssetAmount.div(rates.length).integerValue(BigNumber.ROUND_UP);
        return rates.map(r =>
            createOrder({
                makerAssetAmount: singleTakerAssetAmount.times(r).integerValue(),
                takerAssetAmount: singleTakerAssetAmount,
            }),
        );
    }

    function createOrdersFromBuyRates(makerAssetAmount: BigNumber, rates: Numberish[]): SignedOrder[] {
        const singleMakerAssetAmount = makerAssetAmount.div(rates.length).integerValue(BigNumber.ROUND_UP);
        return rates.map(r =>
            createOrder({
                makerAssetAmount: singleMakerAssetAmount,
                takerAssetAmount: singleMakerAssetAmount.div(r).integerValue(),
            }),
        );
    }

    const ORDER_DOMAIN = {
        exchangeAddress: contractAddresses.exchange,
        chainId: CHAIN_ID,
    };

    function createSamplesFromRates(
        source: ERC20BridgeSource,
        inputs: Numberish[],
        rates: Numberish[],
        fillData?: FillData,
    ): DexSample[] {
        const samples: DexSample[] = [];
        inputs.forEach((input, i) => {
            const rate = rates[i];
            samples.push({
                source,
                fillData: fillData || DEFAULT_FILL_DATA[source],
                input: new BigNumber(input),
                output: new BigNumber(input)
                    .minus(i === 0 ? 0 : samples[i - 1].input)
                    .times(rate)
                    .plus(i === 0 ? 0 : samples[i - 1].output)
                    .integerValue(),
            });
        });
        return samples;
    }

    type GetMultipleQuotesOperation = (
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        fillAmounts: BigNumber[],
        wethAddress: string,
        tokenAdjacencyGraph: TokenAdjacencyGraph,
        liquidityProviderAddress?: string,
    ) => DexSample[][];

    function createGetMultipleSellQuotesOperationFromRates(rates: RatesBySource): GetMultipleQuotesOperation {
        return (
            sources: ERC20BridgeSource[],
            _makerToken: string,
            _takerToken: string,
            fillAmounts: BigNumber[],
            _wethAddress: string,
        ) => {
            return BATCH_SOURCE_FILTERS.getAllowed(sources).map(s => createSamplesFromRates(s, fillAmounts, rates[s]));
        };
    }

    function createGetMultipleBuyQuotesOperationFromRates(rates: RatesBySource): GetMultipleQuotesOperation {
        return (
            sources: ERC20BridgeSource[],
            _makerToken: string,
            _takerToken: string,
            fillAmounts: BigNumber[],
            _wethAddress: string,
        ) => {
            return BATCH_SOURCE_FILTERS.getAllowed(sources).map(s =>
                createSamplesFromRates(s, fillAmounts, rates[s].map(r => new BigNumber(1).div(r))),
            );
        };
    }

    type GetMedianRateOperation = (
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        fillAmounts: BigNumber[],
        wethAddress: string,
        liquidityProviderAddress?: string,
    ) => BigNumber;

    function createGetMedianSellRate(rate: Numberish): GetMedianRateOperation {
        return (
            _sources: ERC20BridgeSource[],
            _makerToken: string,
            _takerToken: string,
            _fillAmounts: BigNumber[],
            _wethAddress: string,
        ) => {
            return new BigNumber(rate);
        };
    }

    function createDecreasingRates(count: number): BigNumber[] {
        const rates: BigNumber[] = [];
        const initialRate = getRandomFloat(1e-3, 1e2);
        _.times(count, () => getRandomFloat(0.95, 1)).forEach((r, i) => {
            const prevRate = i === 0 ? initialRate : rates[i - 1];
            rates.push(prevRate.times(r));
        });
        return rates;
    }

    const NUM_SAMPLES = 3;

    interface RatesBySource {
        [source: string]: Numberish[];
    }

    const ZERO_RATES: RatesBySource = {
        [ERC20BridgeSource.Native]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Eth2Dai]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Uniswap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Kyber]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.UniswapV2]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Balancer]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Bancor]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Curve]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.LiquidityProvider]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.MStable]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Mooniswap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Swerve]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.SnowSwap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.SushiSwap]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.MultiHop]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Shell]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Cream]: _.times(NUM_SAMPLES, () => 0),
        [ERC20BridgeSource.Dodo]: _.times(NUM_SAMPLES, () => 0),
    };

    const DEFAULT_RATES: RatesBySource = {
        ...ZERO_RATES,
        [ERC20BridgeSource.Native]: createDecreasingRates(NUM_SAMPLES),
        [ERC20BridgeSource.Eth2Dai]: createDecreasingRates(NUM_SAMPLES),
        [ERC20BridgeSource.Uniswap]: createDecreasingRates(NUM_SAMPLES),
    };

    interface FillDataBySource {
        [source: string]: FillData;
    }

    const DEFAULT_FILL_DATA: FillDataBySource = {
        [ERC20BridgeSource.UniswapV2]: { tokenAddressPath: [] },
        [ERC20BridgeSource.Balancer]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.Bancor]: { path: [], networkAddress: randomAddress() },
        [ERC20BridgeSource.Kyber]: { hint: '0x', reserveId: '0x' },
        [ERC20BridgeSource.Curve]: {
            pool: {
                poolAddress: randomAddress(),
                tokens: [TAKER_TOKEN, MAKER_TOKEN],
                exchangeFunctionSelector: hexUtils.random(4),
                sellQuoteFunctionSelector: hexUtils.random(4),
                buyQuoteFunctionSelector: hexUtils.random(4),
            },
            fromTokenIdx: 0,
            toTokenIdx: 1,
        },
        [ERC20BridgeSource.Swerve]: {
            pool: {
                poolAddress: randomAddress(),
                tokens: [TAKER_TOKEN, MAKER_TOKEN],
                exchangeFunctionSelector: hexUtils.random(4),
                sellQuoteFunctionSelector: hexUtils.random(4),
                buyQuoteFunctionSelector: hexUtils.random(4),
            },
            fromTokenIdx: 0,
            toTokenIdx: 1,
        },
        [ERC20BridgeSource.SnowSwap]: {
            pool: {
                poolAddress: randomAddress(),
                tokens: [TAKER_TOKEN, MAKER_TOKEN],
                exchangeFunctionSelector: hexUtils.random(4),
                sellQuoteFunctionSelector: hexUtils.random(4),
                buyQuoteFunctionSelector: hexUtils.random(4),
            },
            fromTokenIdx: 0,
            toTokenIdx: 1,
        },
        [ERC20BridgeSource.LiquidityProvider]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.SushiSwap]: { tokenAddressPath: [] },
        [ERC20BridgeSource.Mooniswap]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.Native]: { order: createOrder() },
        [ERC20BridgeSource.MultiHop]: {},
        [ERC20BridgeSource.Shell]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.Cream]: { poolAddress: randomAddress() },
        [ERC20BridgeSource.Dodo]: {},
    };

    const DEFAULT_OPS = {
        getTokenDecimals(_makerAddress: string, _takerAddress: string): BigNumber[] {
            const result = new BigNumber(18);
            return [result, result];
        },
        getOrderFillableTakerAmounts(orders: SignedOrder[]): BigNumber[] {
            return orders.map(o => o.takerAssetAmount);
        },
        getOrderFillableMakerAmounts(orders: SignedOrder[]): BigNumber[] {
            return orders.map(o => o.makerAssetAmount);
        },
        getSellQuotes: createGetMultipleSellQuotesOperationFromRates(DEFAULT_RATES),
        getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(DEFAULT_RATES),
        getMedianSellRate: createGetMedianSellRate(1),
        getBalancerSellQuotesOffChainAsync: (
            _makerToken: string,
            _takerToken: string,
            takerFillAmounts: BigNumber[],
        ) => [
            createSamplesFromRates(
                ERC20BridgeSource.Balancer,
                takerFillAmounts,
                createDecreasingRates(takerFillAmounts.length),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Balancer],
            ),
        ],
        getBalancerBuyQuotesOffChainAsync: (
            _makerToken: string,
            _takerToken: string,
            makerFillAmounts: BigNumber[],
        ) => [
            createSamplesFromRates(
                ERC20BridgeSource.Balancer,
                makerFillAmounts,
                createDecreasingRates(makerFillAmounts.length).map(r => new BigNumber(1).div(r)),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Balancer],
            ),
        ],
        getCreamSellQuotesOffChainAsync: (_makerToken: string, _takerToken: string, takerFillAmounts: BigNumber[]) => [
            createSamplesFromRates(
                ERC20BridgeSource.Cream,
                takerFillAmounts,
                createDecreasingRates(takerFillAmounts.length),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Cream],
            ),
        ],
        getCreamBuyQuotesOffChainAsync: (_makerToken: string, _takerToken: string, makerFillAmounts: BigNumber[]) => [
            createSamplesFromRates(
                ERC20BridgeSource.Cream,
                makerFillAmounts,
                createDecreasingRates(makerFillAmounts.length).map(r => new BigNumber(1).div(r)),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Cream],
            ),
        ],
        getBancorSellQuotesOffChainAsync: (_makerToken: string, _takerToken: string, takerFillAmounts: BigNumber[]) =>
            createSamplesFromRates(
                ERC20BridgeSource.Bancor,
                takerFillAmounts,
                createDecreasingRates(takerFillAmounts.length),
                DEFAULT_FILL_DATA[ERC20BridgeSource.Bancor],
            ),
        getTwoHopSellQuotes: (..._params: any[]) => [],
        getTwoHopBuyQuotes: (..._params: any[]) => [],
    };

    const MOCK_SAMPLER = ({
        async executeAsync(...ops: any[]): Promise<any[]> {
            return MOCK_SAMPLER.executeBatchAsync(ops);
        },
        async executeBatchAsync(ops: any[]): Promise<any[]> {
            return ops;
        },
        balancerPoolsCache: new BalancerPoolsCache(),
        creamPoolsCache: new CreamPoolsCache(),
        liquidityProviderRegistry: {},
    } as any) as DexOrderSampler;

    function replaceSamplerOps(ops: Partial<typeof DEFAULT_OPS> = {}): void {
        Object.assign(MOCK_SAMPLER, DEFAULT_OPS);
        Object.assign(MOCK_SAMPLER, ops);
    }

    describe('getRfqtIndicativeQuotesAsync', () => {
        const partialRfqt: RfqtRequestOpts = {
            apiKey: 'foo',
            takerAddress: NULL_ADDRESS,
            isIndicative: true,
            intentOnFilling: false,
        };

        it('calls RFQT', async () => {
            const requestor = TypeMoq.Mock.ofType(QuoteRequestor, TypeMoq.MockBehavior.Loose);
            requestor
                .setup(r =>
                    r.requestRfqtIndicativeQuotesAsync(
                        TypeMoq.It.isAny(),
                        TypeMoq.It.isAny(),
                        TypeMoq.It.isAny(),
                        TypeMoq.It.isAny(),
                        TypeMoq.It.isAny(),
                        TypeMoq.It.isAny(),
                    ),
                )
                .returns(() => Promise.resolve([]))
                .verifiable(TypeMoq.Times.once());
            await getRfqtIndicativeQuotesAsync(
                MAKER_ASSET_DATA,
                TAKER_ASSET_DATA,
                MarketOperation.Sell,
                new BigNumber('100e18'),
                undefined,
                {
                    rfqt: { quoteRequestor: requestor.object, ...partialRfqt },
                },
            );
            requestor.verifyAll();
        });
    });

    describe('MarketOperationUtils', () => {
        let marketOperationUtils: MarketOperationUtils;

        before(async () => {
            marketOperationUtils = new MarketOperationUtils(MOCK_SAMPLER, contractAddresses, ORDER_DOMAIN);
        });

        describe('getMarketSellOrdersAsync()', () => {
            const FILL_AMOUNT = new BigNumber('100e18');
            const ORDERS = createOrdersFromSellRates(
                FILL_AMOUNT,
                _.times(NUM_SAMPLES, i => DEFAULT_RATES[ERC20BridgeSource.Native][i]),
            );
            const DEFAULT_OPTS: Partial<GetMarketOrdersOpts> = {
                numSamples: NUM_SAMPLES,
                sampleDistributionBase: 1,
                bridgeSlippage: 0,
                maxFallbackSlippage: 100,
                excludedSources: DEFAULT_EXCLUDED,
                allowFallback: false,
                gasSchedule: {},
                feeSchedule: {},
            };

            beforeEach(() => {
                replaceSamplerOps();
            });

            it('queries `numSamples` samples', async () => {
                const numSamples = _.random(1, NUM_SAMPLES);
                let actualNumSamples = 0;
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        actualNumSamples = amounts.length;
                        return DEFAULT_OPS.getSellQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                });
                await marketOperationUtils.getMarketSellOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    numSamples,
                });
                expect(actualNumSamples).eq(numSamples);
            });

            it('polls all DEXes if `excludedSources` is empty', async () => {
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getSellQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopSellQuotes: (...args: any[]) => {
                        sourcesPolled.push(ERC20BridgeSource.MultiHop);
                        return DEFAULT_OPS.getTwoHopSellQuotes(...args);
                    },
                    getBalancerSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                    getCreamSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketSellOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(SELL_SOURCES.slice().sort());
            });

            it('does not poll DEXes in `excludedSources`', async () => {
                const excludedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getSellQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopSellQuotes: (sources: ERC20BridgeSource[], ...args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopSellQuotes(...args);
                    },
                    getBalancerSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                    getCreamSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketSellOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(_.without(SELL_SOURCES, ...excludedSources).sort());
            });

            it('only polls DEXes in `includedSources`', async () => {
                const includedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getSellQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getSellQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopSellQuotes: (sources: ERC20BridgeSource[], ...args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopSellQuotes(sources, ...args);
                    },
                    getBalancerSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                    getCreamSellQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        takerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamSellQuotesOffChainAsync(makerToken, takerToken, takerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketSellOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                    includedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(includedSources.sort());
            });

            it('generates bridge orders with correct asset data', async () => {
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    DEFAULT_OPTS,
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                expect(improvedOrders).to.not.be.length(0);
                for (const order of improvedOrders) {
                    expect(getSourceFromAssetData(order.makerAssetData)).to.exist('');
                    const makerAssetDataPrefix = hexUtils.slice(
                        assetDataUtils.encodeERC20BridgeAssetData(
                            MAKER_TOKEN,
                            constants.NULL_ADDRESS,
                            constants.NULL_BYTES,
                        ),
                        0,
                        36,
                    );
                    assertSamePrefix(order.makerAssetData, makerAssetDataPrefix);
                    expect(order.takerAssetData).to.eq(TAKER_ASSET_DATA);
                }
            });

            it('getMarketSellOrdersAsync() optimizer will be called once only if price-aware RFQ is disabled', async () => {
                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;

                // Ensure that `_generateOptimizedOrdersAsync` is only called once
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .returns(async (a, b) => mockedMarketOpUtils.target._generateOptimizedOrdersAsync(a, b))
                    .verifiable(TypeMoq.Times.once());

                const totalAssetAmount = ORDERS.map(o => o.takerAssetAmount).reduce((a, b) => a.plus(b));
                await mockedMarketOpUtils.object.getMarketSellOrdersAsync(ORDERS, totalAssetAmount, DEFAULT_OPTS);
                mockedMarketOpUtils.verifyAll();
            });

            it('optimizer will send in a comparison price to RFQ providers', async () => {
                // Set up mocked quote requestor, will return an order that is better
                // than the best of the orders.
                const mockedQuoteRequestor = TypeMoq.Mock.ofType(QuoteRequestor, TypeMoq.MockBehavior.Loose, false, {});

                let requestedComparisonPrice: BigNumber | undefined;

                // to get a comparisonPrice, you need a feeschedule for a native order
                const feeSchedule = {
                    [ERC20BridgeSource.Native]: _.constant(new BigNumber(1)),
                };
                mockedQuoteRequestor
                    .setup(mqr =>
                        mqr.requestRfqtFirmQuotesAsync(
                            TypeMoq.It.isAny(),
                            TypeMoq.It.isAny(),
                            TypeMoq.It.isAny(),
                            TypeMoq.It.isAny(),
                            TypeMoq.It.isAny(),
                            TypeMoq.It.isAny(),
                        ),
                    )
                    .callback(
                        (
                            _makerAssetData: string,
                            _takerAssetData: string,
                            _assetFillAmount: BigNumber,
                            _marketOperation: MarketOperation,
                            comparisonPrice: BigNumber | undefined,
                            _options: RfqtRequestOpts,
                        ) => {
                            requestedComparisonPrice = comparisonPrice;
                        },
                    )
                    .returns(async () => {
                        return [
                            {
                                signedOrder: createOrder({
                                    makerAssetData: MAKER_ASSET_DATA,
                                    takerAssetData: TAKER_ASSET_DATA,
                                    makerAssetAmount: Web3Wrapper.toBaseUnitAmount(321, 6),
                                    takerAssetAmount: Web3Wrapper.toBaseUnitAmount(1, 18),
                                }),
                            },
                        ];
                    });

                // Set up sampler, will only return 1 on-chain order
                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(mou =>
                        mou.getMarketSellLiquidityAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAny()),
                    )
                    .returns(async () => {
                        return {
                            dexQuotes: [],
                            ethToInputRate: Web3Wrapper.toBaseUnitAmount(1, 18),
                            ethToOutputRate: Web3Wrapper.toBaseUnitAmount(1, 6),
                            inputAmount: Web3Wrapper.toBaseUnitAmount(1, 18),
                            inputToken: MAKER_TOKEN,
                            outputToken: TAKER_TOKEN,
                            nativeOrders: [
                                createOrder({
                                    makerAssetData: MAKER_ASSET_DATA,
                                    takerAssetData: TAKER_ASSET_DATA,
                                    makerAssetAmount: Web3Wrapper.toBaseUnitAmount(320, 6),
                                    takerAssetAmount: Web3Wrapper.toBaseUnitAmount(1, 18),
                                }),
                            ],
                            orderFillableAmounts: [Web3Wrapper.toBaseUnitAmount(1, 18)],
                            rfqtIndicativeQuotes: [],
                            side: MarketOperation.Sell,
                            twoHopQuotes: [],
                            quoteSourceFilters: new SourceFilters(),
                            makerTokenDecimals: 6,
                            takerTokenDecimals: 18,
                        };
                    });
                const result = await mockedMarketOpUtils.object.getMarketSellOrdersAsync(
                    ORDERS,
                    Web3Wrapper.toBaseUnitAmount(1, 18),
                    {
                        ...DEFAULT_OPTS,
                        feeSchedule,
                        rfqt: {
                            isIndicative: false,
                            apiKey: 'foo',
                            takerAddress: randomAddress(),
                            intentOnFilling: true,
                            priceAwareRFQFlag: PRICE_AWARE_RFQ_ENABLED,
                            quoteRequestor: {
                                requestRfqtFirmQuotesAsync: mockedQuoteRequestor.object.requestRfqtFirmQuotesAsync,
                            } as any,
                        },
                    },
                );
                expect(result.optimizedOrders.length).to.eql(1);
                // tslint:disable-next-line:no-unnecessary-type-assertion
                expect(requestedComparisonPrice!.toString()).to.eql('320');
                expect(result.optimizedOrders[0].makerAssetAmount.toString()).to.eql('321000000');
                expect(result.optimizedOrders[0].takerAssetAmount.toString()).to.eql('1000000000000000000');
            });

            it('getMarketSellOrdersAsync() will not rerun the optimizer if no orders are returned', async () => {
                // Ensure that `_generateOptimizedOrdersAsync` is only called once
                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .returns(async (a, b) => mockedMarketOpUtils.target._generateOptimizedOrdersAsync(a, b))
                    .verifiable(TypeMoq.Times.once());

                const requestor = getMockedQuoteRequestor('firm', [], TypeMoq.Times.once());

                const totalAssetAmount = ORDERS.map(o => o.takerAssetAmount).reduce((a, b) => a.plus(b));
                await mockedMarketOpUtils.object.getMarketSellOrdersAsync(ORDERS, totalAssetAmount, {
                    ...DEFAULT_OPTS,
                    rfqt: {
                        isIndicative: false,
                        apiKey: 'foo',
                        takerAddress: randomAddress(),
                        intentOnFilling: true,
                        priceAwareRFQFlag: PRICE_AWARE_RFQ_ENABLED,
                        quoteRequestor: {
                            requestRfqtFirmQuotesAsync: requestor.object.requestRfqtFirmQuotesAsync,
                        } as any,
                    },
                });
                mockedMarketOpUtils.verifyAll();
                requestor.verifyAll();
            });

            it('getMarketSellOrdersAsync() will rerun the optimizer if one or more indicative are returned', async () => {
                const requestor = getMockedQuoteRequestor('indicative', [ORDERS[0], ORDERS[1]], TypeMoq.Times.once());

                const numOrdersInCall: number[] = [];
                const numIndicativeQuotesInCall: number[] = [];

                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .callback(async (msl: MarketSideLiquidity, _opts: GenerateOptimizedOrdersOpts) => {
                        numOrdersInCall.push(msl.nativeOrders.length);
                        numIndicativeQuotesInCall.push(msl.rfqtIndicativeQuotes.length);
                    })
                    .returns(async (a, b) => mockedMarketOpUtils.target._generateOptimizedOrdersAsync(a, b))
                    .verifiable(TypeMoq.Times.exactly(2));

                const totalAssetAmount = ORDERS.map(o => o.takerAssetAmount).reduce((a, b) => a.plus(b));
                await mockedMarketOpUtils.object.getMarketSellOrdersAsync(
                    ORDERS.slice(2, ORDERS.length),
                    totalAssetAmount,
                    {
                        ...DEFAULT_OPTS,
                        rfqt: {
                            isIndicative: true,
                            apiKey: 'foo',
                            priceAwareRFQFlag: PRICE_AWARE_RFQ_ENABLED,
                            takerAddress: randomAddress(),
                            intentOnFilling: true,
                            quoteRequestor: {
                                requestRfqtIndicativeQuotesAsync: requestor.object.requestRfqtIndicativeQuotesAsync,
                            } as any,
                        },
                    },
                );
                mockedMarketOpUtils.verifyAll();
                requestor.verifyAll();

                // The first and second optimizer call contains same number of RFQ orders.
                expect(numOrdersInCall.length).to.eql(2);
                expect(numOrdersInCall[0]).to.eql(1);
                expect(numOrdersInCall[1]).to.eql(1);

                // The first call to optimizer will have no RFQ indicative quotes. The second call will have
                // two indicative quotes.
                expect(numIndicativeQuotesInCall.length).to.eql(2);
                expect(numIndicativeQuotesInCall[0]).to.eql(0);
                expect(numIndicativeQuotesInCall[1]).to.eql(2);
            });

            it('getMarketSellOrdersAsync() will rerun the optimizer if one or more RFQ orders are returned', async () => {
                const requestor = getMockedQuoteRequestor('firm', [ORDERS[0]], TypeMoq.Times.once());

                // Ensure that `_generateOptimizedOrdersAsync` is only called once

                // TODO: Ensure fillable amounts increase too
                const numOrdersInCall: number[] = [];
                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .callback(async (msl: MarketSideLiquidity, _opts: GenerateOptimizedOrdersOpts) => {
                        numOrdersInCall.push(msl.nativeOrders.length);
                    })
                    .returns(async (a, b) => mockedMarketOpUtils.target._generateOptimizedOrdersAsync(a, b))
                    .verifiable(TypeMoq.Times.exactly(2));

                const totalAssetAmount = ORDERS.map(o => o.takerAssetAmount).reduce((a, b) => a.plus(b));
                await mockedMarketOpUtils.object.getMarketSellOrdersAsync(
                    ORDERS.slice(1, ORDERS.length),
                    totalAssetAmount,
                    {
                        ...DEFAULT_OPTS,
                        rfqt: {
                            isIndicative: false,
                            apiKey: 'foo',
                            takerAddress: randomAddress(),
                            intentOnFilling: true,
                            priceAwareRFQFlag: PRICE_AWARE_RFQ_ENABLED,
                            quoteRequestor: {
                                requestRfqtFirmQuotesAsync: requestor.object.requestRfqtFirmQuotesAsync,
                            } as any,
                        },
                    },
                );
                mockedMarketOpUtils.verifyAll();
                requestor.verifyAll();
                expect(numOrdersInCall.length).to.eql(2);

                // The first call to optimizer was without an RFQ order.
                // The first call to optimizer was with an extra RFQ order.
                expect(numOrdersInCall[0]).to.eql(2);
                expect(numOrdersInCall[1]).to.eql(3);
            });

            it('getMarketSellOrdersAsync() will not raise a NoOptimalPath error if no initial path was found during on-chain DEX optimization, but a path was found after RFQ optimization', async () => {
                let hasFirstOptimizationRun = false;
                let hasSecondOptimizationRun = false;
                const requestor = getMockedQuoteRequestor('firm', [ORDERS[0], ORDERS[1]], TypeMoq.Times.once());

                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .returns(async (msl: MarketSideLiquidity, _opts: GenerateOptimizedOrdersOpts) => {
                        if (msl.nativeOrders.length === 1) {
                            hasFirstOptimizationRun = true;
                            throw new Error(AggregationError.NoOptimalPath);
                        } else if (msl.nativeOrders.length === 3) {
                            hasSecondOptimizationRun = true;
                            return mockedMarketOpUtils.target._generateOptimizedOrdersAsync(msl, _opts);
                        } else {
                            throw new Error('Invalid path. this error message should never appear');
                        }
                    })
                    .verifiable(TypeMoq.Times.exactly(2));

                const totalAssetAmount = ORDERS.map(o => o.takerAssetAmount).reduce((a, b) => a.plus(b));
                await mockedMarketOpUtils.object.getMarketSellOrdersAsync(
                    ORDERS.slice(2, ORDERS.length),
                    totalAssetAmount,
                    {
                        ...DEFAULT_OPTS,
                        rfqt: {
                            isIndicative: false,
                            apiKey: 'foo',
                            takerAddress: randomAddress(),
                            priceAwareRFQFlag: PRICE_AWARE_RFQ_ENABLED,
                            intentOnFilling: true,
                            quoteRequestor: {
                                requestRfqtFirmQuotesAsync: requestor.object.requestRfqtFirmQuotesAsync,
                            } as any,
                        },
                    },
                );
                mockedMarketOpUtils.verifyAll();
                requestor.verifyAll();

                expect(hasFirstOptimizationRun).to.eql(true);
                expect(hasSecondOptimizationRun).to.eql(true);
            });

            it('getMarketSellOrdersAsync() will raise a NoOptimalPath error if no path was found during on-chain DEX optimization and RFQ optimization', async () => {
                const mockedMarketOpUtils = TypeMoq.Mock.ofType(
                    MarketOperationUtils,
                    TypeMoq.MockBehavior.Loose,
                    false,
                    MOCK_SAMPLER,
                    contractAddresses,
                    ORDER_DOMAIN,
                );
                mockedMarketOpUtils.callBase = true;
                mockedMarketOpUtils
                    .setup(m => m._generateOptimizedOrdersAsync(TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                    .returns(async (msl: MarketSideLiquidity, _opts: GenerateOptimizedOrdersOpts) => {
                        throw new Error(AggregationError.NoOptimalPath);
                    })
                    .verifiable(TypeMoq.Times.exactly(1));

                try {
                    await mockedMarketOpUtils.object.getMarketSellOrdersAsync(
                        ORDERS.slice(2, ORDERS.length),
                        ORDERS[0].takerAssetAmount,
                        DEFAULT_OPTS,
                    );
                    expect.fail(`Call should have thrown "${AggregationError.NoOptimalPath}" but instead succeded`);
                } catch (e) {
                    if (e.message !== AggregationError.NoOptimalPath) {
                        expect.fail(e);
                    }
                }
                mockedMarketOpUtils.verifyAll();
            });

            it('generates bridge orders with correct taker amount', async () => {
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    DEFAULT_OPTS,
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const totalTakerAssetAmount = BigNumber.sum(...improvedOrders.map(o => o.takerAssetAmount));
                expect(totalTakerAssetAmount).to.bignumber.gte(FILL_AMOUNT);
            });

            it('generates bridge orders with max slippage of `bridgeSlippage`', async () => {
                const bridgeSlippage = _.random(0.1, true);
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, bridgeSlippage },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                expect(improvedOrders).to.not.be.length(0);
                for (const order of improvedOrders) {
                    const expectedMakerAmount = order.fills[0].output;
                    const slippage = new BigNumber(1).minus(order.makerAssetAmount.div(expectedMakerAmount.plus(1)));
                    assertRoughlyEquals(slippage, bridgeSlippage, 1);
                }
            });

            it('can mix convex sources', async () => {
                const rates: RatesBySource = { ...DEFAULT_RATES };
                rates[ERC20BridgeSource.Native] = [0.4, 0.3, 0.2, 0.1];
                rates[ERC20BridgeSource.Uniswap] = [0.5, 0.05, 0.05, 0.05];
                rates[ERC20BridgeSource.Eth2Dai] = [0.6, 0.05, 0.05, 0.05];
                rates[ERC20BridgeSource.Kyber] = [0, 0, 0, 0]; // unused
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            const ETH_TO_MAKER_RATE = 1.5;

            it('factors in fees for native orders', async () => {
                // Native orders will have the best rates but have fees,
                // dropping their effective rates.
                const nativeFeeRate = 0.06;
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [1, 0.99, 0.98, 0.97], // Effectively [0.94, 0.93, 0.92, 0.91]
                    [ERC20BridgeSource.Uniswap]: [0.96, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Eth2Dai]: [0.95, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Kyber]: [0.1, 0.1, 0.1, 0.1],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Native]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(nativeFeeRate)
                            .dividedToIntegerBy(ETH_TO_MAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('factors in fees for dexes', async () => {
                // Kyber will have the best rates but will have fees,
                // dropping its effective rates.
                const uniswapFeeRate = 0.2;
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [0.95, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Kyber]: [0.1, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Eth2Dai]: [0.92, 0.1, 0.1, 0.1],
                    // Effectively [0.8, ~0.5, ~0, ~0]
                    [ERC20BridgeSource.Uniswap]: [1, 0.7, 0.2, 0.2],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Uniswap]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(uniswapFeeRate)
                            .dividedToIntegerBy(ETH_TO_MAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('can mix one concave source', async () => {
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Kyber]: [0, 0, 0, 0], // Won't use
                    [ERC20BridgeSource.Eth2Dai]: [0.5, 0.85, 0.75, 0.75], // Concave
                    [ERC20BridgeSource.Uniswap]: [0.96, 0.2, 0.1, 0.1],
                    [ERC20BridgeSource.Native]: [0.95, 0.2, 0.2, 0.1],
                };
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('fallback orders use different sources', async () => {
                const rates: RatesBySource = {};
                rates[ERC20BridgeSource.Native] = [0.9, 0.8, 0.5, 0.5];
                rates[ERC20BridgeSource.Uniswap] = [0.6, 0.05, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.4, 0.3, 0.01, 0.01];
                rates[ERC20BridgeSource.Kyber] = [0.35, 0.2, 0.01, 0.01];
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = orderSources.slice(0, 4);
                const secondSources = orderSources.slice(4);
                expect(_.intersection(firstSources, secondSources)).to.be.length(0);
            });

            it('does not create a fallback if below maxFallbackSlippage', async () => {
                const rates: RatesBySource = {};
                rates[ERC20BridgeSource.Native] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Uniswap] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.49, 0.49, 0.49, 0.49];
                rates[ERC20BridgeSource.Kyber] = [0.35, 0.2, 0.01, 0.01];
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true, maxFallbackSlippage: 0.25 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = [ERC20BridgeSource.Native, ERC20BridgeSource.Native, ERC20BridgeSource.Uniswap];
                const secondSources: ERC20BridgeSource[] = [];
                expect(orderSources.slice(0, firstSources.length).sort()).to.deep.eq(firstSources.sort());
                expect(orderSources.slice(firstSources.length).sort()).to.deep.eq(secondSources.sort());
            });

            it('is able to create a order from LiquidityProvider', async () => {
                const liquidityProviderAddress = (DEFAULT_FILL_DATA[ERC20BridgeSource.LiquidityProvider] as any)
                    .poolAddress;
                const rates: RatesBySource = {};
                rates[ERC20BridgeSource.LiquidityProvider] = [1, 1, 1, 1];
                MOCK_SAMPLER.liquidityProviderRegistry[liquidityProviderAddress] = [MAKER_TOKEN, TAKER_TOKEN];
                replaceSamplerOps({
                    getOrderFillableTakerAmounts: () => [constants.ZERO_AMOUNT],
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                });

                const sampler = new MarketOperationUtils(MOCK_SAMPLER, contractAddresses, ORDER_DOMAIN);
                const ordersAndReport = await sampler.getMarketSellOrdersAsync(
                    [
                        createOrder({
                            makerAssetData: assetDataUtils.encodeERC20AssetData(MAKER_TOKEN),
                            takerAssetData: assetDataUtils.encodeERC20AssetData(TAKER_TOKEN),
                        }),
                    ],
                    FILL_AMOUNT,
                    {
                        includedSources: [ERC20BridgeSource.LiquidityProvider],
                        excludedSources: [],
                        numSamples: 4,
                        bridgeSlippage: 0,
                    },
                );
                const result = ordersAndReport.optimizedOrders;
                expect(result.length).to.eql(1);
                expect(result[0].makerAddress).to.eql(liquidityProviderAddress);

                // tslint:disable-next-line:no-unnecessary-type-assertion
                const decodedAssetData = assetDataUtils.decodeAssetDataOrThrow(
                    result[0].makerAssetData,
                ) as ERC20BridgeAssetData;
                expect(decodedAssetData.assetProxyId).to.eql(AssetProxyId.ERC20Bridge);
                expect(decodedAssetData.bridgeAddress).to.eql(liquidityProviderAddress);
                expect(result[0].takerAssetAmount).to.bignumber.eql(FILL_AMOUNT);
            });

            it('factors in exchange proxy gas overhead', async () => {
                // Uniswap has a slightly better rate than LiquidityProvider,
                // but LiquidityProvider is better accounting for the EP gas overhead.
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [0.01, 0.01, 0.01, 0.01],
                    [ERC20BridgeSource.Uniswap]: [1, 1, 1, 1],
                    [ERC20BridgeSource.LiquidityProvider]: [0.9999, 0.9999, 0.9999, 0.9999],
                };
                MOCK_SAMPLER.liquidityProviderRegistry[randomAddress()] = [MAKER_TOKEN, TAKER_TOKEN];
                replaceSamplerOps({
                    getSellQuotes: createGetMultipleSellQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_MAKER_RATE),
                });
                const optimizer = new MarketOperationUtils(MOCK_SAMPLER, contractAddresses, ORDER_DOMAIN);
                const gasPrice = 100e9; // 100 gwei
                const exchangeProxyOverhead = (sourceFlags: number) =>
                    sourceFlags === SOURCE_FLAGS.LiquidityProvider
                        ? constants.ZERO_AMOUNT
                        : new BigNumber(1.3e5).times(gasPrice);
                const improvedOrdersResponse = await optimizer.getMarketSellOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    {
                        ...DEFAULT_OPTS,
                        numSamples: 4,
                        includedSources: [
                            ERC20BridgeSource.Native,
                            ERC20BridgeSource.Uniswap,
                            ERC20BridgeSource.LiquidityProvider,
                        ],
                        excludedSources: [],
                        exchangeProxyOverhead,
                    },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [ERC20BridgeSource.LiquidityProvider];
                expect(orderSources).to.deep.eq(expectedSources);
            });
        });

        describe('getMarketBuyOrdersAsync()', () => {
            const FILL_AMOUNT = new BigNumber('100e18');
            const ORDERS = createOrdersFromBuyRates(
                FILL_AMOUNT,
                _.times(NUM_SAMPLES, () => DEFAULT_RATES[ERC20BridgeSource.Native][0]),
            );
            const DEFAULT_OPTS: Partial<GetMarketOrdersOpts> = {
                numSamples: NUM_SAMPLES,
                sampleDistributionBase: 1,
                bridgeSlippage: 0,
                maxFallbackSlippage: 100,
                excludedSources: DEFAULT_EXCLUDED,
                allowFallback: false,
                gasSchedule: {},
                feeSchedule: {},
            };

            beforeEach(() => {
                replaceSamplerOps();
            });

            it('queries `numSamples` samples', async () => {
                const numSamples = _.random(1, 16);
                let actualNumSamples = 0;
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        actualNumSamples = amounts.length;
                        return DEFAULT_OPS.getBuyQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                });
                await marketOperationUtils.getMarketBuyOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    numSamples,
                });
                expect(actualNumSamples).eq(numSamples);
            });

            it('polls all DEXes if `excludedSources` is empty', async () => {
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getBuyQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopBuyQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopBuyQuotes(..._args);
                    },
                    getBalancerBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                    getCreamBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketBuyOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.equals(BUY_SOURCES.sort());
            });

            it('does not poll DEXes in `excludedSources`', async () => {
                const excludedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getBuyQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopBuyQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopBuyQuotes(..._args);
                    },
                    getBalancerBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                    getCreamBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketBuyOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.eq(_.without(BUY_SOURCES, ...excludedSources).sort());
            });

            it('only polls DEXes in `includedSources`', async () => {
                const includedSources = [ERC20BridgeSource.Uniswap, ERC20BridgeSource.Eth2Dai];
                let sourcesPolled: ERC20BridgeSource[] = [];
                replaceSamplerOps({
                    getBuyQuotes: (sources, makerToken, takerToken, amounts, wethAddress) => {
                        sourcesPolled = sourcesPolled.concat(sources.slice());
                        return DEFAULT_OPS.getBuyQuotes(
                            sources,
                            makerToken,
                            takerToken,
                            amounts,
                            wethAddress,
                            TOKEN_ADJACENCY_GRAPH,
                        );
                    },
                    getTwoHopBuyQuotes: (sources: ERC20BridgeSource[], ..._args: any[]) => {
                        if (sources.length !== 0) {
                            sourcesPolled.push(ERC20BridgeSource.MultiHop);
                            sourcesPolled.push(...sources);
                        }
                        return DEFAULT_OPS.getTwoHopBuyQuotes(..._args);
                    },
                    getBalancerBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Balancer);
                        return DEFAULT_OPS.getBalancerBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                    getCreamBuyQuotesOffChainAsync: (
                        makerToken: string,
                        takerToken: string,
                        makerFillAmounts: BigNumber[],
                    ) => {
                        sourcesPolled = sourcesPolled.concat(ERC20BridgeSource.Cream);
                        return DEFAULT_OPS.getCreamBuyQuotesOffChainAsync(makerToken, takerToken, makerFillAmounts);
                    },
                });
                await marketOperationUtils.getMarketBuyOrdersAsync(ORDERS, FILL_AMOUNT, {
                    ...DEFAULT_OPTS,
                    excludedSources: [],
                    includedSources,
                });
                expect(_.uniq(sourcesPolled).sort()).to.deep.eq(includedSources.sort());
            });

            it('generates bridge orders with correct asset data', async () => {
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    DEFAULT_OPTS,
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                expect(improvedOrders).to.not.be.length(0);
                for (const order of improvedOrders) {
                    expect(getSourceFromAssetData(order.makerAssetData)).to.exist('');
                    const makerAssetDataPrefix = hexUtils.slice(
                        assetDataUtils.encodeERC20BridgeAssetData(
                            MAKER_TOKEN,
                            constants.NULL_ADDRESS,
                            constants.NULL_BYTES,
                        ),
                        0,
                        36,
                    );
                    assertSamePrefix(order.makerAssetData, makerAssetDataPrefix);
                    expect(order.takerAssetData).to.eq(TAKER_ASSET_DATA);
                }
            });

            it('generates bridge orders with correct maker amount', async () => {
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    DEFAULT_OPTS,
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const totalMakerAssetAmount = BigNumber.sum(...improvedOrders.map(o => o.makerAssetAmount));
                expect(totalMakerAssetAmount).to.bignumber.gte(FILL_AMOUNT);
            });

            it('generates bridge orders with max slippage of `bridgeSlippage`', async () => {
                const bridgeSlippage = _.random(0.1, true);
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    // Pass in empty orders to prevent native orders from being used.
                    ORDERS.map(o => ({ ...o, makerAssetAmount: constants.ZERO_AMOUNT })),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, bridgeSlippage },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                expect(improvedOrders).to.not.be.length(0);
                for (const order of improvedOrders) {
                    const expectedTakerAmount = order.fills[0].output;
                    const slippage = order.takerAssetAmount.div(expectedTakerAmount.plus(1)).minus(1);
                    assertRoughlyEquals(slippage, bridgeSlippage, 1);
                }
            });

            it('can mix convex sources', async () => {
                const rates: RatesBySource = { ...ZERO_RATES };
                rates[ERC20BridgeSource.Native] = [0.4, 0.3, 0.2, 0.1];
                rates[ERC20BridgeSource.Uniswap] = [0.5, 0.05, 0.05, 0.05];
                rates[ERC20BridgeSource.Eth2Dai] = [0.6, 0.05, 0.05, 0.05];
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            const ETH_TO_TAKER_RATE = 1.5;

            it('factors in fees for native orders', async () => {
                // Native orders will have the best rates but have fees,
                // dropping their effective rates.
                const nativeFeeRate = 0.06;
                const rates: RatesBySource = {
                    ...ZERO_RATES,
                    [ERC20BridgeSource.Native]: [1, 0.99, 0.98, 0.97], // Effectively [0.94, ~0.93, ~0.92, ~0.91]
                    [ERC20BridgeSource.Uniswap]: [0.96, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Eth2Dai]: [0.95, 0.1, 0.1, 0.1],
                    [ERC20BridgeSource.Kyber]: [0.1, 0.1, 0.1, 0.1],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Native]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(nativeFeeRate)
                            .dividedToIntegerBy(ETH_TO_TAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_TAKER_RATE),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Uniswap,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Native,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('factors in fees for dexes', async () => {
                // Uniswap will have the best rates but will have fees,
                // dropping its effective rates.
                const uniswapFeeRate = 0.2;
                const rates: RatesBySource = {
                    ...ZERO_RATES,
                    [ERC20BridgeSource.Native]: [0.95, 0.1, 0.1, 0.1],
                    // Effectively [0.8, ~0.5, ~0, ~0]
                    [ERC20BridgeSource.Uniswap]: [1, 0.7, 0.2, 0.2],
                    [ERC20BridgeSource.Eth2Dai]: [0.92, 0.1, 0.1, 0.1],
                };
                const feeSchedule = {
                    [ERC20BridgeSource.Uniswap]: _.constant(
                        FILL_AMOUNT.div(4)
                            .times(uniswapFeeRate)
                            .dividedToIntegerBy(ETH_TO_TAKER_RATE),
                    ),
                };
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_TAKER_RATE),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, feeSchedule },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [
                    ERC20BridgeSource.Native,
                    ERC20BridgeSource.Eth2Dai,
                    ERC20BridgeSource.Uniswap,
                ];
                expect(orderSources.sort()).to.deep.eq(expectedSources.sort());
            });

            it('fallback orders use different sources', async () => {
                const rates: RatesBySource = { ...ZERO_RATES };
                rates[ERC20BridgeSource.Native] = [0.9, 0.8, 0.5, 0.5];
                rates[ERC20BridgeSource.Uniswap] = [0.6, 0.05, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.4, 0.3, 0.01, 0.01];
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = orderSources.slice(0, 4);
                const secondSources = orderSources.slice(4);
                expect(_.intersection(firstSources, secondSources)).to.be.length(0);
            });

            it('does not create a fallback if below maxFallbackSlippage', async () => {
                const rates: RatesBySource = { ...ZERO_RATES };
                rates[ERC20BridgeSource.Native] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Uniswap] = [1, 1, 0.01, 0.01];
                rates[ERC20BridgeSource.Eth2Dai] = [0.49, 0.49, 0.49, 0.49];
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                });
                const improvedOrdersResponse = await marketOperationUtils.getMarketBuyOrdersAsync(
                    createOrdersFromBuyRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    { ...DEFAULT_OPTS, numSamples: 4, allowFallback: true, maxFallbackSlippage: 0.25 },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const firstSources = [ERC20BridgeSource.Native, ERC20BridgeSource.Native, ERC20BridgeSource.Uniswap];
                const secondSources: ERC20BridgeSource[] = [];
                expect(orderSources.slice(0, firstSources.length).sort()).to.deep.eq(firstSources.sort());
                expect(orderSources.slice(firstSources.length).sort()).to.deep.eq(secondSources.sort());
            });

            it('factors in exchange proxy gas overhead', async () => {
                // Uniswap has a slightly better rate than LiquidityProvider,
                // but LiquidityProvider is better accounting for the EP gas overhead.
                const rates: RatesBySource = {
                    [ERC20BridgeSource.Native]: [0.01, 0.01, 0.01, 0.01],
                    [ERC20BridgeSource.Uniswap]: [1, 1, 1, 1],
                    [ERC20BridgeSource.LiquidityProvider]: [0.9999, 0.9999, 0.9999, 0.9999],
                };
                MOCK_SAMPLER.liquidityProviderRegistry[randomAddress()] = [MAKER_TOKEN, TAKER_TOKEN];
                replaceSamplerOps({
                    getBuyQuotes: createGetMultipleBuyQuotesOperationFromRates(rates),
                    getMedianSellRate: createGetMedianSellRate(ETH_TO_TAKER_RATE),
                });
                const optimizer = new MarketOperationUtils(MOCK_SAMPLER, contractAddresses, ORDER_DOMAIN);
                const gasPrice = 100e9; // 100 gwei
                const exchangeProxyOverhead = (sourceFlags: number) =>
                    sourceFlags === SOURCE_FLAGS.LiquidityProvider
                        ? constants.ZERO_AMOUNT
                        : new BigNumber(1.3e5).times(gasPrice);
                const improvedOrdersResponse = await optimizer.getMarketBuyOrdersAsync(
                    createOrdersFromSellRates(FILL_AMOUNT, rates[ERC20BridgeSource.Native]),
                    FILL_AMOUNT,
                    {
                        ...DEFAULT_OPTS,
                        numSamples: 4,
                        includedSources: [
                            ERC20BridgeSource.Native,
                            ERC20BridgeSource.Uniswap,
                            ERC20BridgeSource.LiquidityProvider,
                        ],
                        excludedSources: [],
                        exchangeProxyOverhead,
                    },
                );
                const improvedOrders = improvedOrdersResponse.optimizedOrders;
                const orderSources = improvedOrders.map(o => o.fills[0].source);
                const expectedSources = [ERC20BridgeSource.LiquidityProvider];
                expect(orderSources).to.deep.eq(expectedSources);
            });
        });
    });

    describe('createFills', () => {
        const takerAssetAmount = new BigNumber(5000000);
        const ethToOutputRate = new BigNumber(0.5);
        // tslint:disable-next-line:no-object-literal-type-assertion
        const smallOrder = {
            chainId: 1,
            makerAddress: 'SMALL_ORDER',
            takerAddress: NULL_ADDRESS,
            takerAssetAmount,
            makerAssetAmount: takerAssetAmount.times(2),
            makerFee: ZERO_AMOUNT,
            takerFee: ZERO_AMOUNT,
            makerAssetData: '0xf47261b0000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            takerAssetData: '0xf47261b0000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            makerFeeAssetData: '0x',
            takerFeeAssetData: '0x',
            fillableTakerAssetAmount: takerAssetAmount,
            fillableMakerAssetAmount: takerAssetAmount.times(2),
            fillableTakerFeeAmount: ZERO_AMOUNT,
        } as SignedOrderWithFillableAmounts;
        const largeOrder = {
            ...smallOrder,
            makerAddress: 'LARGE_ORDER',
            fillableMakerAssetAmount: smallOrder.fillableMakerAssetAmount.times(2),
            fillableTakerAssetAmount: smallOrder.fillableTakerAssetAmount.times(2),
            makerAssetAmount: smallOrder.makerAssetAmount.times(2),
            takerAssetAmount: smallOrder.takerAssetAmount.times(2),
        };
        const orders = [smallOrder, largeOrder];
        const feeSchedule = {
            [ERC20BridgeSource.Native]: _.constant(2e5),
        };

        it('penalizes native fill based on target amount when target is smaller', () => {
            const path = createFills({
                side: MarketOperation.Sell,
                orders,
                dexQuotes: [],
                targetInput: takerAssetAmount.minus(1),
                ethToOutputRate,
                feeSchedule,
            });
            expect((path[0][0].fillData as NativeFillData).order.makerAddress).to.eq(smallOrder.makerAddress);
            expect(path[0][0].input).to.be.bignumber.eq(takerAssetAmount.minus(1));
        });

        it('penalizes native fill based on available amount when target is larger', () => {
            const path = createFills({
                side: MarketOperation.Sell,
                orders,
                dexQuotes: [],
                targetInput: POSITIVE_INF,
                ethToOutputRate,
                feeSchedule,
            });
            expect((path[0][0].fillData as NativeFillData).order.makerAddress).to.eq(largeOrder.makerAddress);
            expect((path[0][1].fillData as NativeFillData).order.makerAddress).to.eq(smallOrder.makerAddress);
        });
    });
});
// tslint:disable-next-line: max-file-line-count
