/**
 * index.js — Solana Yield Optimizer
 *
 * Full pipeline: fetchApys → getPositions → compare → (rebalance) → report
 *
 * Usage:
 *   import { runOptimizer } from './index.js'
 *   const { report } = await runOptimizer({ wallet: '...', dryRun: true })
 *
 * CLI:
 *   node index.js --wallet <base58>  --dry-run
 *   node index.js --wallet <base58>  --staking-only --no-il
 */

import { fetchApys, fetchPoolHistory, getPoolAvgApy7d } from "./tools/fetchApys.js";
import { getPositions, getNativeSolBalance, getNativeStakePositions, getLiquidStakingPositions } from "./tools/getPositions.js";
import { rebalance } from "./tools/rebalance.js";
import { generateReport } from "./tools/report.js";

export { fetchApys, fetchPoolHistory, getPoolAvgApy7d, getPositions, getNativeSolBalance, getNativeStakePositions, getLiquidStakingPositions, rebalance, generateReport };

const MIN_REBALANCE_DELTA_PP = 2.0;

const PROTOCOL_SLUG = {
  "Marinade":         "marinade",
  "Jito":             "jito-sol",
  "BlazeStake":       "blaze-stake",
  "Lido":             "lido",
  "Sanctum Infinity": "sanctum-infinity",
  "Native Staking":   null,
};

/**
 * Runs the full Solana yield optimization pipeline.
 *
 * @param {object} opts
 * @param {string}   opts.wallet              – Solana base58 public key
 * @param {boolean}  [opts.dryRun=true]       – simulate without sending txs
 * @param {boolean}  [opts.autoConfirm=false] – skip confirmation gate (for automation)
 * @param {boolean}  [opts.stakingOnly=false] – only liquid staking protocols
 * @param {boolean}  [opts.noIl=false]        – skip IL-exposed pools
 * @param {number}   [opts.minTvl=1_000_000]
 * @param {number}   [opts.minDeltaPp=2]      – min APY gain (pp) to trigger rebalance
 * @param {string}   [opts.outputPath]        – save report to file
 */
async function runOptimizer(opts = {}) {
  const {
    wallet,
    dryRun      = true,
    autoConfirm = false,
    stakingOnly = false,
    noIl        = false,
    minTvl      = 1_000_000,
    minDeltaPp  = MIN_REBALANCE_DELTA_PP,
    outputPath  = null,
  } = opts;

  if (!wallet) throw new Error("wallet (Solana base58 pubkey) is required");

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║       Solana Yield Optimizer  ·  v0.2.0       ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  // Step 1 — Live APYs
  console.log("Step 1/4  Fetching live Solana APYs from DeFiLlama...");
  const pools = await fetchApys({ topN: 50, minTvl, stakingOnly, noIlOnly: noIl });
  console.log(`          Found ${pools.length} qualifying pools.\n`);

  // Step 2 — Current positions
  console.log("Step 2/4  Reading on-chain positions...");
  const positionData = await getPositions(wallet);
  const { positions } = positionData;
  console.log(`          Found ${positions.length} active position(s).`);
  if (positionData.summary.totalStakedSol > 0) {
    console.log(`          Total staked SOL: ${positionData.summary.totalStakedSol}\n`);
  }

  if (positions.length === 0) {
    console.log("No active positions — showing best opportunities.\n");
    const report = await generateReport({ wallet, summaryOnly: true, outputPath });
    return { report, opportunity: null, rebalanceResult: null };
  }

  // Step 3 — Compare
  console.log("Step 3/4  Comparing positions to available APYs...");
  let bestOpportunity = null;

  for (const pos of positions.filter((p) => p.type !== "wallet")) {
    const slug        = PROTOCOL_SLUG[pos.protocol] ?? null;
    const currentPool = slug ? pools.find((p) => p.project === slug) : null;
    const currentApy  = currentPool?.apy ?? 0;
    const bestAlt     = pools.find((p) => p.project !== slug && p.isLiquidStaking);
    if (!bestAlt) continue;

    const delta = bestAlt.apy - currentApy;
    if (!bestOpportunity || delta > (bestOpportunity.bestAlt.apy - bestOpportunity.currentApy)) {
      bestOpportunity = { currentProtocol: pos.protocol, currentSymbol: pos.symbol, currentApy, bestAlt, delta, position: pos };
    }
  }

  if (bestOpportunity) {
    const o = bestOpportunity;
    console.log(`\n  Best opportunity:`);
    console.log(`    Current  : ${o.currentProtocol} ${o.currentSymbol} → ${o.currentApy.toFixed(2)}% APY`);
    console.log(`    Candidate: ${o.bestAlt.project} ${o.bestAlt.symbol} → ${o.bestAlt.apy.toFixed(2)}% APY`);
    console.log(`    Delta    : +${o.delta.toFixed(2)} pp\n`);
  } else {
    console.log("  No rebalance candidates found.\n");
  }

  // Step 4 — Rebalance
  let rebalanceResult = null;

  if (bestOpportunity && bestOpportunity.delta >= minDeltaPp) {
    if (!autoConfirm && !dryRun) {
      console.log(`⚠️  Opportunity found (+${bestOpportunity.delta.toFixed(2)} pp) but autoConfirm=false.\n   Re-run with --auto-confirm true to execute.\n`);
    } else {
      console.log(`Step 4/4  Executing rebalance (dryRun=${dryRun})...`);
      const o = bestOpportunity;
      rebalanceResult = await rebalance({
        wallet,
        from:   o.currentSymbol,
        to:     o.bestAlt.symbol,
        amount: o.position.amount,
        dryRun,
      });
    }
  } else if (bestOpportunity) {
    console.log(`  Delta (${bestOpportunity.delta.toFixed(2)} pp) < threshold (${minDeltaPp} pp) — no rebalance.\n`);
  }

  console.log("Generating report...");
  const report = await generateReport({ wallet, summaryOnly: true, outputPath });
  return { report, opportunity: bestOpportunity, rebalanceResult };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) {
      const name = key.slice(2);
      const val  = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[name] = val;
    }
  }
  return args;
}

if (process.argv[1].endsWith("index.js")) {
  const args = parseArgs(process.argv.slice(2));

  runOptimizer({
    wallet:      args["wallet"]       ?? process.env.SOLANA_WALLET,
    dryRun:      args["dry-run"]      !== "false",
    autoConfirm: args["auto-confirm"] === "true",
    stakingOnly: args["staking-only"] === "true",
    noIl:        args["no-il"]        === "true",
    minTvl:      args["min-tvl"]      ? Number(args["min-tvl"]) : undefined,
    minDeltaPp:  args["min-delta"]    ? Number(args["min-delta"]) : MIN_REBALANCE_DELTA_PP,
    outputPath:  args["output"]       ?? null,
  })
    .then(({ report }) => { console.log("\n" + report); process.exit(0); })
    .catch((err) => { console.error(`\n❌ ${err.message}`); process.exit(1); });
}
