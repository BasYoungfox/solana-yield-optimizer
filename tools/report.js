/**
 * tools/report.js
 * Generates a formatted markdown portfolio report for Solana.
 *
 * Modes:
 *   --summary-only          Current positions with USD values and APYs.
 *   --before X --after Y    Adds before/after rebalance diff.
 *
 * Prices: DeFiLlama Coins API
 * APYs:   DeFiLlama Yields API
 *
 * CLI:
 *   node tools/report.js --wallet <base58> --summary-only
 *   node tools/report.js --wallet <base58> --summary-only --output report.md
 */

import { writeFile } from "fs/promises";
import { getPositions } from "./getPositions.js";
import { fetchApys } from "./fetchApys.js";

// ─── Token address registry (Solana) ─────────────────────────────────────────

const TOKEN_ADDRESSES = {
  SOL:     "So11111111111111111111111111111111111111112",
  mSOL:    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  JitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  bSOL:    "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
  stSOL:   "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",
  INF:     "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
  USDC:    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT:    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

// ─── Price fetching ───────────────────────────────────────────────────────────

async function fetchPrices(symbols) {
  const keys = symbols
    .filter((s) => TOKEN_ADDRESSES[s])
    .map((s) => `solana:${TOKEN_ADDRESSES[s]}`);

  if (keys.length === 0) return {};

  const url = `https://coins.llama.fi/prices/current/${keys.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DeFiLlama price API error: ${res.status}`);

  const { coins } = await res.json();
  const priceMap  = {};

  for (const [key, data] of Object.entries(coins)) {
    const symbol = data.symbol ?? key.split(":")[1];
    priceMap[symbol] = data.price;
  }

  for (const stable of ["USDC", "USDT"]) {
    if (!priceMap[stable]) priceMap[stable] = 1.0;
  }

  return priceMap;
}

// ─── APY index ────────────────────────────────────────────────────────────────

async function buildApyIndex() {
  const pools = await fetchApys({ topN: 100, minTvl: 0, minApy: 0 });
  const index = {};
  for (const pool of pools) {
    index[`${pool.project}:${pool.symbol.toUpperCase()}`] = pool.apy;
  }
  return index;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

const fmt = {
  usd:    (n) => n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  pct:    (n) => n == null ? "—" : `${n.toFixed(2)}%`,
  amount: (n, sym) => n == null ? "—" : `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${sym}`,
  delta:  (n) => n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`,
};

function pad(str, len) { return String(str ?? "").padEnd(len); }

function mdTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line   = (cells) => "| " + cells.map((c, i) => pad(c, widths[i])).join(" | ") + " |";
  const sep    = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

const PROTOCOL_SLUG = {
  "Marinade":         "marinade",
  "Jito":             "jito-sol",
  "BlazeStake":       "blaze-stake",
  "Lido":             "lido",
  "Sanctum Infinity": "sanctum-infinity",
  "Native Staking":   "native",
};

// ─── Report builder ───────────────────────────────────────────────────────────

function buildReport({ wallet, positionData, prices, apyIndex, before, after }) {
  const { positions } = positionData;
  const lines = [];
  const now   = new Date().toUTCString();

  lines.push("# Solana Yield Report");
  lines.push(`**Wallet:** \`${wallet}\`  `);
  lines.push(`**Chain:** Solana  `);
  lines.push(`**Generated:** ${now}`);
  lines.push("");

  // ── Portfolio snapshot ────────────────────────────────────────────────────
  lines.push("## Portfolio Snapshot");
  lines.push("");

  if (positions.length === 0) {
    lines.push("> No active staking positions found for this wallet on Solana.");
    lines.push("");
  } else {
    const rows = [];
    let totalUsd = 0, weightedApy = 0;

    for (const pos of positions) {
      const price    = prices[pos.symbol] ?? prices[pos.underlying] ?? null;
      const slug     = PROTOCOL_SLUG[pos.protocol] ?? pos.protocol.toLowerCase().replace(/\s+/g, "-");
      const apy      = apyIndex[`${slug}:${pos.symbol.toUpperCase()}`] ?? null;
      const usdValue = price != null ? pos.amount * price : null;
      const annYield = apy != null && usdValue != null ? (usdValue * apy) / 100 : null;

      if (usdValue) totalUsd   += usdValue;
      if (apy && usdValue) weightedApy += apy * usdValue;

      const typeLabel = pos.type === "stake" ? "Native Stake" : pos.type === "liquid-stake" ? "Liquid Stake" : pos.type;
      const extra     = pos.validator ? ` (${pos.validator.slice(0, 8)}...)` : pos.status ? ` [${pos.status}]` : "";

      rows.push([
        pos.protocol,
        typeLabel,
        fmt.amount(pos.amount, pos.symbol) + extra,
        fmt.usd(usdValue),
        fmt.pct(apy),
        fmt.usd(annYield),
      ]);
    }

    const blendedApy = totalUsd > 0 ? weightedApy / totalUsd : null;
    const annTotal   = blendedApy != null ? (totalUsd * blendedApy) / 100 : null;

    lines.push(mdTable(
      ["Protocol", "Type", "Amount", "USD Value", "APY", "Est. Annual Yield"],
      rows
    ));
    lines.push("");
    lines.push(`**Total Portfolio Value:** ${fmt.usd(totalUsd)}  `);
    lines.push(`**Blended APY:** ${fmt.pct(blendedApy)}  `);
    lines.push(`**Estimated Annual Yield:** ${fmt.usd(annTotal)}`);
    lines.push("");
  }

  // ── Rebalance summary ─────────────────────────────────────────────────────
  if (before && after) {
    lines.push("---");
    lines.push("");
    lines.push("## Rebalance Summary");
    lines.push("");

    const calcTotals = (posSet) => {
      let totalUsd = 0, weightedApy = 0;
      for (const pos of posSet) {
        const price = prices[pos.symbol] ?? prices[pos.underlying] ?? 0;
        const slug  = PROTOCOL_SLUG[pos.protocol] ?? "";
        const apy   = apyIndex[`${slug}:${pos.symbol.toUpperCase()}`] ?? 0;
        const usd   = pos.amount * price;
        totalUsd   += usd;
        weightedApy += apy * usd;
      }
      const blendedApy = totalUsd > 0 ? weightedApy / totalUsd : 0;
      return { totalUsd, blendedApy, annualYield: (totalUsd * blendedApy) / 100 };
    };

    const b = calcTotals(before.positions ?? []);
    const a = calcTotals(after.positions  ?? []);

    lines.push(mdTable(
      ["Metric", "Before", "After", "Change"],
      [
        ["Portfolio Value",   fmt.usd(b.totalUsd),    fmt.usd(a.totalUsd),    fmt.usd(a.totalUsd - b.totalUsd)],
        ["Blended APY",       fmt.pct(b.blendedApy),  fmt.pct(a.blendedApy),  fmt.delta(a.blendedApy - b.blendedApy)],
        ["Est. Annual Yield", fmt.usd(b.annualYield),  fmt.usd(a.annualYield), fmt.usd(a.annualYield - b.annualYield)],
      ]
    ));
    lines.push("");

    const apyDelta = a.blendedApy - b.blendedApy;
    lines.push(apyDelta >= 0
      ? `> ✅ Rebalance improved blended APY by **${fmt.delta(apyDelta)}**, adding ~${fmt.usd(a.annualYield - b.annualYield)}/yr.`
      : `> ⚠️  Rebalance reduced blended APY by **${fmt.delta(apyDelta)}**. Review positions above.`
    );
    lines.push("");
  }

  // ── Top opportunities ─────────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## Top Solana Opportunities Right Now");
  lines.push("");
  lines.push("*(from DeFiLlama — TVL > $1M, sorted by APY)*");
  lines.push("");

  const activeSlugs = new Set(
    positions.map((p) => `${PROTOCOL_SLUG[p.protocol] ?? ""}:${p.symbol.toUpperCase()}`)
  );

  const topOpps = Object.entries(apyIndex)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([key, apy]) => {
      const [project, symbol] = key.split(":");
      return [project, symbol, fmt.pct(apy), activeSlugs.has(key) ? "✅ Active" : ""];
    });

  lines.push(topOpps.length > 0
    ? mdTable(["Protocol", "Pool", "APY", "Status"], topOpps)
    : "*Could not load opportunity data.*"
  );
  lines.push("");
  lines.push("---");
  lines.push("*Powered by [DeFiLlama](https://defillama.com) · Data may lag by up to 1 hour*");

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function generateReport(opts = {}) {
  const { wallet, before, after, summaryOnly = false, outputPath = null } = opts;

  if (!wallet) throw new Error("wallet is required");

  console.log("⟳ Fetching current positions...");
  const positionData = await getPositions(wallet);

  const symbols = [...new Set([
    ...positionData.positions.map((p) => p.symbol),
    "SOL",
  ])];

  console.log("⟳ Fetching token prices...");
  console.log("⟳ Fetching live APYs...");
  const [prices, apyIndex] = await Promise.all([fetchPrices(symbols), buildApyIndex()]);

  const report = buildReport({
    wallet,
    positionData,
    prices,
    apyIndex,
    before: summaryOnly ? null : before,
    after:  summaryOnly ? null : after,
  });

  if (outputPath) {
    await writeFile(outputPath, report, "utf8");
    console.log(`✓ Report saved to ${outputPath}`);
  }

  return report;
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

if (process.argv[1].endsWith("report.js")) {
  const args = parseArgs(process.argv.slice(2));
  const wallet = args["wallet"] ?? process.env.SOLANA_WALLET;

  if (!wallet) {
    console.error("Error: --wallet or SOLANA_WALLET env var is required.");
    process.exit(1);
  }

  const before      = args["before"] ? JSON.parse(args["before"]) : null;
  const after       = args["after"]  ? JSON.parse(args["after"])  : null;
  const summaryOnly = args["summary-only"] === true || (!before && !after);
  const outputPath  = args["output"] ?? null;

  generateReport({ wallet, before, after, summaryOnly, outputPath })
    .then((r) => { console.log("\n" + r); process.exit(0); })
    .catch((e) => { console.error(`\n❌ ${e.message}`); process.exit(1); });
}

export { generateReport };
