/**
 * tools/solana/fetchApys.js
 * Pulls live APY data from DeFiLlama for Solana staking protocols.
 *
 * Focused on:
 *   - Liquid staking    (Marinade, Jito, BlazeStake, Sanctum, Lido)
 *   - Lending markets   (MarginFi, Kamino, Solend/Save)
 *   - LP / concentrated (Orca Whirlpools, Raydium CLMM)
 */

const DEFILLAMA_POOLS_URL = "https://yields.llama.fi/pools";
const TARGET_CHAIN = "Solana";

/**
 * Liquid staking protocol slugs — shown first in comparisons.
 * Ordered by TVL dominance on Solana.
 */
const LIQUID_STAKING_SLUGS = new Set([
  "marinade",
  "jito-sol",
  "blaze-stake",
  "lido",
  "sanctum-infinity",
  "jupiter-perpetuals", // JLP vault also relevant
  "spl-stake-pool",
]);

/**
 * Fetches all Solana yield pools from DeFiLlama.
 *
 * @param {object} [opts]
 * @param {number}  [opts.minTvl=1_000_000]  – min TVL (Solana pools are bigger)
 * @param {number}  [opts.minApy=0.01]
 * @param {number}  [opts.topN=20]
 * @param {boolean} [opts.stakingOnly=false]  – only liquid staking protocols
 * @param {boolean} [opts.stableOnly=false]
 * @param {boolean} [opts.noIlOnly=false]
 * @param {string}  [opts.project]
 * @returns {Promise<Pool[]>}
 */
async function fetchApys(opts = {}) {
  const {
    minTvl      = 1_000_000,
    minApy      = 0.01,
    topN        = 20,
    stakingOnly = false,
    stableOnly  = false,
    noIlOnly    = false,
    project     = null,
  } = opts;

  const response = await fetch(DEFILLAMA_POOLS_URL);
  if (!response.ok) {
    throw new Error(`DeFiLlama API error: ${response.status} ${response.statusText}`);
  }

  const { status, data } = await response.json();
  if (status !== "success" || !Array.isArray(data)) {
    throw new Error("Unexpected DeFiLlama response shape");
  }

  const pools = data
    .filter((p) => p.chain === TARGET_CHAIN)
    .filter((p) => typeof p.tvlUsd === "number" && p.tvlUsd >= minTvl)
    .filter((p) => typeof p.apy    === "number" && p.apy    >= minApy)
    .filter((p) => !stakingOnly || LIQUID_STAKING_SLUGS.has(p.project))
    .filter((p) => !stableOnly  || p.stablecoin === true)
    .filter((p) => !noIlOnly    || p.ilRisk !== "yes")
    .filter((p) => !project     || p.project === project)
    .sort((a, b) => b.apy - a.apy)
    .slice(0, topN)
    .map((p) => ({
      poolId:           p.pool,
      project:          p.project,
      symbol:           p.symbol,
      chain:            p.chain,
      tvlUsd:           p.tvlUsd,
      apy:              p.apy,
      apyBase:          p.apyBase   ?? null,
      apyReward:        p.apyReward ?? null,
      ilRisk:           p.ilRisk    ?? null,
      stablecoin:       p.stablecoin ?? false,
      isLiquidStaking:  LIQUID_STAKING_SLUGS.has(p.project),
      underlyingTokens: p.underlyingTokens ?? [],
      rewardTokens:     p.rewardTokens     ?? [],
    }));

  return pools;
}

/**
 * APY history for a single pool.
 * @param {string} poolId
 */
async function fetchPoolHistory(poolId) {
  if (!poolId) throw new Error("poolId is required");
  const res = await fetch(`https://yields.llama.fi/chart/${poolId}`);
  if (!res.ok) throw new Error(`Chart API error: ${res.status}`);
  const { status, data } = await res.json();
  if (status !== "success") throw new Error("Unexpected chart response");
  return data.map((d) => ({
    timestamp: d.timestamp,
    tvlUsd:    d.tvlUsd,
    apy:       d.apy,
    apyBase:   d.apyBase   ?? null,
    apyReward: d.apyReward ?? null,
  }));
}

/**
 * 7-day average APY — smooths out MEV/reward spikes common in Solana staking.
 * @param {string} poolId
 */
async function getPoolAvgApy7d(poolId) {
  const history = await fetchPoolHistory(poolId);
  const last7   = history.slice(-7);
  if (last7.length === 0) return 0;
  const avg = last7.reduce((s, d) => s + (d.apy ?? 0), 0) / last7.length;
  return parseFloat(avg.toFixed(4));
}

export { fetchApys, fetchPoolHistory, getPoolAvgApy7d };
