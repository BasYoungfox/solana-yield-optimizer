# ◎ Solana Yield Optimizer

> An AI-powered Solana staking agent that monitors live APYs across every major liquid staking protocol, reads your on-chain positions, and automatically moves your SOL to wherever it earns the most — via Jupiter routing, with your confirmation before anything moves.

![Solana](https://img.shields.io/badge/Solana-black?style=flat&logo=solana&logoColor=14F195)
![Node](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat&logo=node.js&logoColor=white)
![DeFiLlama](https://img.shields.io/badge/Data-DeFiLlama-blue?style=flat)
![Jupiter](https://img.shields.io/badge/Swaps-Jupiter%20V6-orange?style=flat)
![License](https://img.shields.io/badge/License-MIT-green?style=flat)

---

## What This Does

Most SOL holders are silently leaving yield on the table. Marinade, Jito, BlazeStake, Sanctum and native validator staking all pay different rates that shift daily based on MEV rewards and incentive emissions. Tracking this manually is tedious and most people never bother.

This agent does it automatically. It pulls live APY data from DeFiLlama across every major Solana staking protocol, reads your actual on-chain positions, calculates whether you could be earning more, and executes the rebalance if you give it the green light. The swap routing goes through Jupiter, which finds the best path whether you are moving from mSOL to JitoSOL, SOL to bSOL, or anything in between.

It runs as an OpenClaw skill, meaning you interact with it in plain English through a chat interface rather than running scripts manually.

---

## Protocols Supported

| Protocol         | Token    | Type              |
|------------------|----------|-------------------|
| Marinade Finance | mSOL     | Liquid staking    |
| Jito             | JitoSOL  | Liquid staking    |
| BlazeStake       | bSOL     | Liquid staking    |
| Lido             | stSOL    | Liquid staking    |
| Sanctum Infinity | INF      | Liquid staking    |
| Native Staking   | SOL      | Validator staking |
| MarginFi         | Various  | Lending           |
| Kamino           | Various  | Lending           |

---

## How It Works

The agent runs a four step pipeline on every request.

**Step 1 — Live APY fetch**
Pulls current yield data from the DeFiLlama Yields API across all Solana pools. Filters by TVL, IL risk, and protocol type. Returns ranked opportunities sorted by APY.

**Step 2 — On-chain position read**
Connects to Solana mainnet via RPC and reads your wallet's actual state. This includes native stake accounts (with validator address and activation status), SPL token balances for all liquid staking tokens, and lending deposits on MarginFi and Kamino. Everything is batched into as few RPC calls as possible.

**Step 3 — Comparison and opportunity detection**
Compares your current positions against the best available rates. Only flags a rebalance if the gain is at least 2 percentage points above what you are currently earning. This threshold exists to prevent constant churn for marginal improvements.

**Step 4 — Rebalance via Jupiter**
If you confirm the opportunity, the agent fetches a Jupiter V6 quote showing you the exact route, expected output, and price impact before anything happens. You see the dry run first. Only after a second confirmation does it sign and broadcast the transaction.

---

## Tech Stack

```
@solana/web3.js     On-chain reads: stake accounts, SPL balances, RPC calls
Jupiter V6 API      Swap routing across all Solana DEX liquidity
DeFiLlama API       Live APY data, no API key required
OpenClaw            AI agent runtime, skill system, chat interface
Node.js ESM         Runtime, no transpilation needed
```

---

## Project Structure

```
solana-yield-optimizer/
├── SKILL.md                  OpenClaw skill definition and agent instructions
├── index.js                  Full pipeline orchestrator and CLI entry point
├── package.json
└── tools/
    ├── fetchApys.js          DeFiLlama APY fetcher with filtering and 7d smoothing
    ├── getPositions.js       On-chain position reader for all supported protocols
    ├── rebalance.js          Jupiter swap execution and native stake delegation
    └── report.js             Markdown portfolio report with USD values and APY data
```

---

## Getting Started

**Prerequisites**

You need Node.js 18 or higher and a Solana wallet.

```bash
git clone https://github.com/BasYoungfox/solana-yield-optimizer
cd solana-yield-optimizer
npm install
```

**Environment variables**

```bash
export SOLANA_WALLET=your_base58_public_key
export SOLANA_RPC_URL=https://api.mainnet-beta.solana.com   # optional
export SOLANA_PRIVATE_KEY=your_base58_private_key           # only needed for live rebalancing
```

**Run without installing OpenClaw**

```bash
# Check best Solana staking APYs right now
node -e "import('./tools/fetchApys.js').then(({fetchApys}) => fetchApys({ topN: 10, stakingOnly: true }).then(p => console.log(JSON.stringify(p, null, 2))))"

# Read your current positions
node -e "import('./tools/getPositions.js').then(({getPositions}) => getPositions(process.env.SOLANA_WALLET).then(r => console.log(JSON.stringify(r, null, 2))))"

# Full portfolio report
node tools/report.js --summary-only

# Full optimizer pipeline (dry run, no transactions sent)
node index.js --dry-run
```

**Run a simulated rebalance**

```bash
node tools/rebalance.js \
  --wallet $SOLANA_WALLET \
  --from mSOL \
  --to JitoSOL \
  --amount 10 \
  --dry-run true
```

---

## OpenClaw Setup

Install OpenClaw globally, then copy the skill and set your wallet:

```bash
npm install -g openclaw@latest
openclaw onboard
```

Copy the skill:
```bash
# Windows
xcopy "solana-yield-optimizer" "%USERPROFILE%\.openclaw\skills\solana-yield-optimizer\" /E /I

# macOS / Linux
cp -r solana-yield-optimizer ~/.openclaw/skills/
```

Add your wallet in the OpenClaw config:
```json
{
  "env": {
    "SOLANA_WALLET": "your_base58_address"
  }
}
```

Add your private key through the secure vault only:
```bash
openclaw env set SOLANA_PRIVATE_KEY
```

Then open the dashboard and talk to it:
```bash
openclaw dashboard
```

```
"Show my SOL staking positions"
"What is the best staking APY right now?"
"Am I getting the best yield?"
"Move my mSOL to JitoSOL"
"Stake 5 SOL with the best validator"
```

---

## Safety

The private key is never logged, echoed, or included in any report output. Every rebalance shows a dry run with the full Jupiter quote before asking for confirmation. Failed transactions surface the error and stop immediately without retrying. The 2pp delta threshold means the agent will never recommend a rebalance for a marginal gain that would not justify the transaction cost.

---

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--wallet` | `SOLANA_WALLET` env | Solana public key |
| `--dry-run` | `true` | Simulate without sending transactions |
| `--auto-confirm` | `false` | Skip confirmation gate (for automation) |
| `--staking-only` | `false` | Only liquid staking protocols |
| `--no-il` | `false` | Exclude impermanent loss pools |
| `--min-tvl` | `1000000` | Minimum pool TVL in USD |
| `--min-delta` | `2.0` | Minimum APY improvement in percentage points |
| `--output` | none | Save report to a markdown file |

---

## License

MIT
