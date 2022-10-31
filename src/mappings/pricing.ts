/* eslint-disable prefer-const */
import { Pair, Token, Bundle } from '../types/schema'
import { BigDecimal, Address, BigInt } from '@graphprotocol/graph-ts/index'
import { ZERO_BD, factoryContract, ADDRESS_ZERO, ONE_BD, UNTRACKED_PAIRS } from './helpers'

// TODO: debug joy, update, and update token  getEthPriceInUSD
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006'
const USDC_WETH_PAIR = '0xfa337e55273ea2ca5207df252526ce57fbb1dcfb'
const DAI_WETH_PAIR = '0x2f4966088b286a02db2710f6da93bb328c8275e1'
const USDT_WETH_PAIR = '0x9e1515c85b892a99011fa6553b5d27bb024eb4ec'

export function getEthPriceInUSD(): BigDecimal {
  // fetch eth prices for each stablecoin
  let daiPair = Pair.load(DAI_WETH_PAIR) // dai is token1
  let usdcPair = Pair.load(USDC_WETH_PAIR) // usdc is token1
  let usdtPair = Pair.load(USDT_WETH_PAIR) // usdt is token1

  // all 3 have been created
  if (daiPair !== null && usdcPair !== null && usdtPair !== null) {
    let totalLiquidityETH = daiPair.reserve0.plus(usdcPair.reserve0).plus(usdtPair.reserve0)
    let daiWeight = daiPair.reserve0.div(totalLiquidityETH)
    let usdcWeight = usdcPair.reserve0.div(totalLiquidityETH)
    let usdtWeight = usdtPair.reserve0.div(totalLiquidityETH)
    return daiPair.token1Price
      .times(daiWeight)
      .plus(usdcPair.token1Price.times(usdcWeight))
      .plus(usdtPair.token1Price.times(usdtWeight))
  } else if (daiPair !== null && usdcPair !== null) {
    // dai and USDC have been created
    let totalLiquidityETH = daiPair.reserve0.plus(usdcPair.reserve0)
    let daiWeight = daiPair.reserve0.div(totalLiquidityETH)
    let usdcWeight = usdcPair.reserve0.div(totalLiquidityETH)
    return daiPair.token1Price.times(daiWeight).plus(usdcPair.token1Price.times(usdcWeight))
  } else if (usdcPair !== null) {
    // USDC is the only pair so far
    return usdcPair.token1Price
  } else {
    return ZERO_BD
  }
  return ZERO_BD
}

// TODO: debug joy, update whitelist
// token where amounts should contribute to tracked volume and liquidity
let WHITELIST: string[] = [
  '0x4200000000000000000000000000000000000006', // WETH
  '0xec6b24429ab7012afc1b083d4e6763f738047792', // USDT
  '0x4603cff6498c46583300fc5f1c31f872f5514182', // USDC
  '0xb9297783d0d568dc378e23d5ba9c32031a4a5132', // DAI
]

// minimum liquidity required to count towards tracked volume for pairs with small # of Lps
let MINIMUM_USD_THRESHOLD_NEW_PAIRS = BigDecimal.fromString('400000')

// minimum liquidity for price to get tracked
let MINIMUM_LIQUIDITY_THRESHOLD_ETH = BigDecimal.fromString('2')

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export function findEthPerToken(token: Token): BigDecimal {
  if (token.id == WETH_ADDRESS) {
    return ONE_BD
  }
  // loop through whitelist and check if paired with any
  for (let i = 0; i < WHITELIST.length; ++i) {
    let volatilePairAddress = factoryContract.getPair(Address.fromString(token.id), Address.fromString(WHITELIST[i]), false).toHexString()
    let stablePairAddress = factoryContract.getPair(Address.fromString(token.id), Address.fromString(WHITELIST[i]), true).toHexString()
    if (volatilePairAddress != ADDRESS_ZERO) {
      let volatilePair = Pair.load(volatilePairAddress)
      if (volatilePair.token0 == token.id && volatilePair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        let token1 = Token.load(volatilePair.token1)
        return volatilePair.token1Price.times(token1.derivedETH as BigDecimal) // return token1 per our token * Eth per token 1
      }
      if (volatilePair.token1 == token.id && volatilePair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        let token0 = Token.load(volatilePair.token0)
        return volatilePair.token0Price.times(token0.derivedETH as BigDecimal) // return token0 per our token * ETH per token 0
      }
    }else if (stablePairAddress != ADDRESS_ZERO) {
      let stablePair = Pair.load(stablePairAddress)
      if (stablePair.token0 == token.id && stablePair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        let token1 = Token.load(stablePair.token1)
        return stablePair.token1Price.times(token1.derivedETH as BigDecimal) // return token1 per our token * Eth per token 1
      }
      if (stablePair.token1 == token.id && stablePair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        let token0 = Token.load(stablePair.token0)
        return stablePair.token0Price.times(token0.derivedETH as BigDecimal) // return token0 per our token * ETH per token 0
      }
    }
  }
  return ZERO_BD // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD.
 * If both are, return average of two amounts
 * If neither is, return 0
 */
export function getTrackedVolumeUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
  pair: Pair
): BigDecimal {
  let bundle = Bundle.load('1')
  let price0 = token0.derivedETH.times(bundle.ethPrice)
  let price1 = token1.derivedETH.times(bundle.ethPrice)

  // dont count tracked volume on these pairs - usually rebass tokens
  if (UNTRACKED_PAIRS.includes(pair.id)) {
    return ZERO_BD
  }

  // if less than 5 LPs, require high minimum reserve amount amount or return 0
  if (pair.liquidityProviderCount.lt(BigInt.fromI32(5))) {
    let reserve0USD = pair.reserve0.times(price0)
    let reserve1USD = pair.reserve1.times(price1)
    if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve0USD.plus(reserve1USD).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
      if (reserve0USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve1USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
  }

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0
      .times(price0)
      .plus(tokenAmount1.times(price1))
      .div(BigDecimal.fromString('2'))
  }

  // take full value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0)
  }

  // take full value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1)
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedLiquidityUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  let bundle = Bundle.load('1')
  let price0 = token0.derivedETH.times(bundle.ethPrice)
  let price1 = token1.derivedETH.times(bundle.ethPrice)

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1))
  }

  // take double value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}
