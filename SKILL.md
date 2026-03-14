---
name: solana-yield-optimizer
description: >
  Maximize Solana staking yield. Use when the user asks to optimize SOL staking,
  compare Marinade vs Jito vs BlazeStake, check staking APYs, move SOL to higher
  yield, show staking positions, or get a Solana portfolio summary.
version: "0.2.0"
author: "solana-yield-optimizer"
keywords: ["solana", "sol", "staking", "yield", "marinade", "jito", "blazestake", "msol", "jitosol", "bsol", "rebalance", "apy", "jupiter", "defi"]
user-invocable: true
tools: ["bash", "read", "write"]
env:
  - name: SOLANA_WALLET
    required: true
    description: "Solana base58 public key — used for all position reads and rebalances."
  - name: SOLANA_RPC_URL
    required: false
    description: "Solana RPC endpoint. Defaults to https://api.mainnet-beta.solana.com"
  - name: SOLANA_PRIVATE_KEY
    required: false
    description: "Solana keypair as base58 string or JSON byte array — only needed when executing a rebalance."
dependencies:
  - name: node
    type: system
    required: true
  - name: "@solana/web3.js"
    type: npm
    required: true
  - name: bs58
    type: npm
    required: true
gates:
  - type: env
    name: SOLANA_WALLET
  - type: tool
    name: bash
metadata: {"openclaw":{"emoji":"◎","os":["linux","darwin","win32"],"requires":{"anyBins":["node"]},"primaryEnv":"SOLANA_WALLET"}}
---

# Solana Yield Optimizer

Reads a wallet's live Solana staking positions, compares them against the best
available APYs via DeFiLlama, and — if the user confirms — executes a rebalance
via Jupiter.

## Protocols covered

| Protocol         | Type         | What's tracked                              |
|------------------|--------------|---------------------------------------------|
| Native Staking   | Validator    | Stake accounts, validator, active/deactivating |
| Marinade         | Liquid Stake | mSOL balance                                |
| Jito             | Liquid Stake | JitoSOL balance                             |
| BlazeStake       | Liquid Stake | bSOL balance                                |
| Lido             | Liquid Stake | stSOL balance                               |
| Sanctum Infinity | Liquid Stake | INF balance                                 |
| MarginFi         | Lending      | Deposit balances                            |
| Kamino           | Lending      | Obligation deposits                         |

---

## Environment Variables

- `${SOLANA_WALLET}` — wallet address for all reads. Always use this.
- `${SOLANA_RPC_URL}` — optional RPC override.
- `${SOLANA_PRIVATE_KEY}` — only use when user confirms a live rebalance. Never log it.

---

## Workflow

### Step 1 — Fetch live Solana APYs

```bash
node -e "
import('./tools/fetchApys.js').then(({ fetchApys }) =>
  fetchApys({ topN: 15, minTvl: 1000000 }).then(pools =>
    console.log(JSON.stringify(pools, null, 2))
  )
)"
```

- Add `stakingOnly: true` for liquid staking protocols only.
- Add `noIlOnly: true` to skip impermanent loss pools.

### Step 2 — Read current positions

```bash
node -e "
import('./tools/getPositions.js').then(({ getPositions }) =>
  getPositions('${SOLANA_WALLET}').then(r =>
    console.log(JSON.stringify(r, null, 2))
  )
)"
```

Returns: native SOL balance, native stake accounts (with validator + status),
liquid staking tokens (mSOL, JitoSOL, bSOL, stSOL, INF), MarginFi and Kamino deposits.

Note: `status: "deactivating"` stake accounts are cooling down (~2-3 days). Warn the user.

### Step 3 — Compare and present opportunity

Compare current positions to available APYs. Show clearly:

```
Current  : Marinade mSOL   → 6.1% APY
Best alt : Jito JitoSOL    → 7.3% APY
Delta    : +1.2 pp  (~+$X/yr)
```

Only flag a rebalance if delta ≥ 2pp OR user explicitly asked for the best rate.
**Always ask "Shall I rebalance?" before Step 4.**

### Step 4a — Rebalance (after confirmation)

Always dry run first:
```bash
node tools/rebalance.js \
  --wallet "${SOLANA_WALLET}" \
  --from mSOL \
  --to JitoSOL \
  --amount 10 \
  --dry-run true
```

Show the dry run output (Jupiter quote, route, price impact) then ask: "Looks good?"

Live execution only after user confirms:
```bash
node tools/rebalance.js \
  --wallet "${SOLANA_WALLET}" \
  --from mSOL \
  --to JitoSOL \
  --amount 10
```

Native validator staking:
```bash
node tools/rebalance.js \
  --wallet "${SOLANA_WALLET}" \
  --from SOL \
  --to native \
  --amount 10 \
  --validator <VOTE_ACCOUNT_ADDRESS>
```

If `SOLANA_PRIVATE_KEY` is not set, stop and tell the user to add it in OpenClaw Settings → Environment Variables.

### Step 4b — Report

```bash
node tools/report.js --wallet "${SOLANA_WALLET}" --summary-only
```

---

## Decision tree

```
User message
    │
    ▼
Step 1: fetchApys()
    │
    ▼
Step 2: getPositions()
    │
    ├─ No positions? → Show top opportunities, ask if they want to enter
    │
    ▼
Step 3: Compare APYs
    │
    ├─ delta < 2pp? → Report only, note "already well-positioned"
    │
    └─ delta ≥ 2pp → Show comparison, ask "Shall I rebalance?"
            │
            ├─ Yes → dry run → show quote → "Looks good?" → live
            └─ No  → report only
```

---

## Safety rules

- **Always dry run first.** Show the Jupiter quote before going live.
- **Never rebalance without explicit user confirmation.**
- **Never log or expose `${SOLANA_PRIVATE_KEY}`** in any output.
- **Never retry a failed transaction.** Surface the error, let the user decide.
- Warn if Jupiter price impact > 0.5%.
- Warn if `status: "deactivating"` — SOL won't be liquid for ~2-3 days.

---

## Examples

- *"What's the best Solana staking APY?"* → Step 1 only, `stakingOnly: true`
- *"Show my SOL staking positions"* → Step 2 only
- *"Is Jito better than Marinade right now?"* → Step 1, compare those two
- *"Am I getting the best yield?"* → Steps 1–3
- *"Move my mSOL to JitoSOL"* → Full pipeline
- *"Stake 5 SOL with the best option"* → Step 1 + Step 4a
- *"Unstake my SOL"* → Step 2 to find stake accounts, explain cooldown
