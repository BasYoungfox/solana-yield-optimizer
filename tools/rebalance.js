/**
 * tools/solana/rebalance.js
 * Executes a Solana staking rebalance: unstake → (swap) → restake.
 *
 * Execution layer: Jupiter V6 API (handles all LST routing on Solana).
 * Jupiter finds the best route whether you're swapping SOL → mSOL,
 * JitoSOL → bSOL, or any other liquid staking token pair.
 *
 * Supported operations:
 *   SOL      → any LST  (stake)
 *   any LST  → SOL      (unstake / liquid)
 *   LST      → LST      (rebalance between protocols)
 *   SOL      → native   (create stake account, delegate to validator)
 *
 * CLI:
 *   node tools/solana/rebalance.js \
 *     --wallet   <base58-pubkey>   \
 *     --from     SOL               \
 *     --to       JitoSOL           \
 *     --amount   10                \    <- in SOL units
 *     [--slippage-bps 50]          \
 *     [--dry-run]
 *
 * Env:
 *   SOLANA_PRIVATE_KEY  – base58 keypair secret OR JSON array of bytes
 *   SOLANA_RPC_URL      – optional, defaults to mainnet-beta
 */

import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  StakeProgram,
  Authorized,
  Lockup,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL     = process.env.SOLANA_RPC_URL     ?? "https://api.mainnet-beta.solana.com";
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;

const JUPITER_QUOTE_API = "https://public.jupiterapi.com/quote";
const JUPITER_SWAP_API  = "https://public.jupiterapi.com/swap";

const GAS_WARN_SOL = 0.01; // warn if fee > 0.01 SOL

// ─── Token mint registry ──────────────────────────────────────────────────────

const TOKEN_MINTS = {
  SOL:     "So11111111111111111111111111111111111111112",  // wrapped SOL mint
  mSOL:    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  JitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  bSOL:    "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
  stSOL:   "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",
  INF:     "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
  LST:     "LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp",
  jupSOL:  "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
  USDC:    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT:    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

const TOKEN_DECIMALS = {
  SOL: 9, mSOL: 9, JitoSOL: 9, bSOL: 9, stSOL: 9,
  INF: 9, LST: 9, jupSOL: 9, USDC: 6, USDT: 6,
};

// ─── Wallet loading ───────────────────────────────────────────────────────────

function loadKeypair(rawKey) {
  if (!rawKey) return null;
  try {
    // JSON byte array format: [1,2,3,...]
    if (rawKey.trim().startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey)));
    }
    // Base58 format
    return Keypair.fromSecretKey(bs58.decode(rawKey));
  } catch (err) {
    throw new Error(`Failed to parse SOLANA_PRIVATE_KEY: ${err.message}`);
  }
}

// ─── Jupiter V6 — quote ───────────────────────────────────────────────────────

/**
 * Gets a swap quote from Jupiter V6.
 *
 * @param {string} fromSymbol   – e.g. "SOL"
 * @param {string} toSymbol     – e.g. "JitoSOL"
 * @param {number} amountUnits  – in lamports/raw units (not UI amount)
 * @param {number} slippageBps  – e.g. 50 = 0.5%
 * @returns {Promise<JupiterQuote>}
 */
async function getJupiterQuote(fromSymbol, toSymbol, amountUnits, slippageBps = 50) {
  const inputMint  = TOKEN_MINTS[fromSymbol];
  const outputMint = TOKEN_MINTS[toSymbol];

  if (!inputMint)  throw new Error(`Unknown token: "${fromSymbol}"`);
  if (!outputMint) throw new Error(`Unknown token: "${toSymbol}"`);

  const url = new URL(JUPITER_QUOTE_API);
  url.searchParams.set("inputMint",        inputMint);
  url.searchParams.set("outputMint",       outputMint);
  url.searchParams.set("amount",           String(amountUnits));
  url.searchParams.set("slippageBps",      String(slippageBps));
  url.searchParams.set("onlyDirectRoutes", "false");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter quote failed (${res.status}): ${body}`);
  }

  const quote = await res.json();
  if (quote.error) throw new Error(`Jupiter quote error: ${quote.error}`);

  return quote;
}

/**
 * Logs a human-readable quote summary.
 */
function logQuote(quote, fromSymbol, toSymbol) {
  const inDec  = TOKEN_DECIMALS[fromSymbol]  ?? 9;
  const outDec = TOKEN_DECIMALS[toSymbol]    ?? 9;

  const inAmt  = (parseInt(quote.inAmount)       / 10 ** inDec).toFixed(6);
  const outAmt = (parseInt(quote.outAmount)       / 10 ** outDec).toFixed(6);
  const minOut = (parseInt(quote.otherAmountThreshold) / 10 ** outDec).toFixed(6);
  const impact = quote.priceImpactPct ? `${(parseFloat(quote.priceImpactPct) * 100).toFixed(3)}%` : "—";

  console.log(`\n  Jupiter quote:`);
  console.log(`    In:            ${inAmt} ${fromSymbol}`);
  console.log(`    Out:           ${outAmt} ${toSymbol}`);
  console.log(`    Min out:       ${minOut} ${toSymbol}`);
  console.log(`    Price impact:  ${impact}`);
  console.log(`    Route:         ${quote.routePlan?.map((r) => r.swapInfo?.label ?? "?").join(" → ") ?? "—"}`);
}

// ─── Jupiter V6 — execute swap ────────────────────────────────────────────────

/**
 * Builds and sends a Jupiter swap transaction.
 * @param {JupiterQuote} quote
 * @param {Keypair}      keypair
 * @param {Connection}   connection
 * @param {boolean}      dryRun
 */
async function executeJupiterSwap(quote, keypair, connection, dryRun) {
  if (dryRun) {
    console.log("  [DRY RUN] Swap transaction not sent.");
    return null;
  }

  // Build swap transaction
  const swapRes = await fetch(JUPITER_SWAP_API, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      quoteResponse:        quote,
      userPublicKey:        keypair.publicKey.toBase58(),
      wrapAndUnwrapSol:     true,   // auto-wrap SOL to wSOL
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!swapRes.ok) {
    const body = await swapRes.text();
    throw new Error(`Jupiter swap API error (${swapRes.status}): ${body}`);
  }

  const { swapTransaction } = await swapRes.json();
  if (!swapTransaction) throw new Error("Jupiter returned no swapTransaction");

  // Deserialize, sign, send
  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx    = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries:    3,
  });
  console.log(`  ✓ Swap tx: ${sig}`);
  console.log("  ⟳ Confirming...");

  const confirmation = await connection.confirmTransaction(sig, "confirmed");
  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  console.log("  ✓ Confirmed");
  return sig;
}

// ─── Native staking ───────────────────────────────────────────────────────────

/**
 * Creates a native stake account and delegates to a validator.
 * Used when toProtocol is "native" and you want on-chain validator staking.
 *
 * @param {object} opts
 * @param {Keypair}    opts.keypair
 * @param {Connection} opts.connection
 * @param {number}     opts.amountSol
 * @param {string}     opts.validatorVoteAccount – base58 vote account address
 * @param {boolean}    opts.dryRun
 */
async function delegateToValidator({ keypair, connection, amountSol, validatorVoteAccount, dryRun }) {
  console.log(`\n[Native Staking] Delegating ${amountSol} SOL to validator ${validatorVoteAccount}...`);

  if (dryRun) {
    console.log("  [DRY RUN] Stake delegation not sent.");
    return null;
  }

  const stakeAccount = Keypair.generate();
  const lamports     = Math.floor(amountSol * LAMPORTS_PER_SOL);

  // Minimum rent-exempt balance for stake account (~0.00228 SOL)
  const rentExempt = await connection.getMinimumBalanceForRentExemption(
    StakeProgram.space
  );

  const tx = StakeProgram.createAccountWithSeed({
    fromPubkey:       keypair.publicKey,
    stakePubkey:      stakeAccount.publicKey,
    basePubkey:       keypair.publicKey,
    seed:             `stake:${Date.now()}`,
    authorized:       new Authorized(keypair.publicKey, keypair.publicKey),
    lockup:           new Lockup(0, 0, keypair.publicKey),
    lamports:         lamports + rentExempt,
  });

  // Append delegate instruction
  const delegateTx = StakeProgram.delegate({
    stakePubkey:      stakeAccount.publicKey,
    authorizedPubkey: keypair.publicKey,
    votePubkey:       new PublicKey(validatorVoteAccount),
  });

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash  = blockhash;
  tx.feePayer         = keypair.publicKey;
  tx.add(delegateTx);

  const sig = await sendAndConfirmTransaction(connection, tx, [keypair, stakeAccount]);
  console.log(`  ✓ Stake + delegate tx: ${sig}`);
  console.log(`  ✓ Stake account: ${stakeAccount.publicKey.toBase58()}`);
  return { sig, stakeAccount: stakeAccount.publicKey.toBase58() };
}

// ─── Main rebalance orchestrator ──────────────────────────────────────────────

/**
 * @param {object} params
 * @param {string}  params.wallet           – base58 public key
 * @param {string}  params.from             – "SOL", "mSOL", "JitoSOL", etc.
 * @param {string}  params.to               – target token symbol
 * @param {number}  params.amount           – amount in token units (not lamports)
 * @param {number}  [params.slippageBps=50] – slippage tolerance in bps
 * @param {string}  [params.validator]      – validator vote account (native staking only)
 * @param {boolean} [params.dryRun=false]
 */
async function rebalance(params) {
  const {
    wallet,
    from,
    to,
    amount,
    slippageBps = 50,
    validator   = null,
    dryRun      = false,
  } = params;

  if (!dryRun && !PRIVATE_KEY) {
    throw new Error("SOLANA_PRIVATE_KEY env var is required for live execution. Use --dry-run to simulate.");
  }

  const keypair    = dryRun ? null : loadKeypair(PRIVATE_KEY);
  const connection = new Connection(RPC_URL, "confirmed");

  console.log("\n══════════════════════════════════════════════");
  console.log("  Solana Yield Optimizer — Rebalance");
  console.log(`  ${from} → ${to}  |  Amount: ${amount}`);
  console.log(`  Slippage: ${slippageBps}bps  |  Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log("══════════════════════════════════════════════\n");

  // Native staking path (SOL → validator)
  if (to === "native") {
    if (!validator) throw new Error("--validator <vote-account> is required for native staking");
    const result = await delegateToValidator({ keypair, connection, amountSol: amount, validatorVoteAccount: validator, dryRun });
    return { success: true, dryRun, from, to: "native", amount, result };
  }

  // Jupiter swap path (any LST ↔ any LST, or SOL ↔ LST)
  const fromDecimals = TOKEN_DECIMALS[from] ?? 9;
  const amountUnits  = BigInt(Math.floor(amount * 10 ** fromDecimals));

  console.log(`Fetching Jupiter quote for ${amount} ${from} → ${to}...`);
  const quote = await getJupiterQuote(from, to, amountUnits.toString(), slippageBps);
  logQuote(quote, from, to);

  // Gas estimate check
  const feeLamports = parseInt(quote.prioritizationFeeLamports ?? 5000);
  const feeSOL      = feeLamports / LAMPORTS_PER_SOL;
  if (feeSOL > GAS_WARN_SOL) {
    console.warn(`\n  ⚠️  Priority fee (${feeSOL.toFixed(6)} SOL) is high. Proceed with caution.`);
  }

  console.log("\nExecuting swap...");
  const sig = await executeJupiterSwap(quote, keypair, connection, dryRun);

  const toDecimals = TOKEN_DECIMALS[to] ?? 9;
  const receivedAmount = parseInt(quote.outAmount) / 10 ** toDecimals;

  console.log("\n══════════════════════════════════════════════");
  console.log(`  ✅ Rebalance ${dryRun ? "simulation" : "execution"} complete.`);
  console.log("══════════════════════════════════════════════\n");

  return {
    success:  true,
    dryRun,
    from,
    to,
    sentAmount:     amount,
    receivedAmount,
    txSignature:    sig,
    route:          quote.routePlan?.map((r) => r.swapInfo?.label ?? "?") ?? [],
  };
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

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

if (process.argv[1].endsWith("rebalance.js")) {
  const args = parseArgs(process.argv.slice(2));

  const params = {
    wallet:      args["wallet"]       ?? process.env.WALLET_ADDRESS,
    from:        args["from"],
    to:          args["to"],
    amount:      args["amount"]       ? parseFloat(args["amount"]) : null,
    slippageBps: args["slippage-bps"] ? parseInt(args["slippage-bps"]) : 50,
    validator:   args["validator"]    ?? null,
    dryRun:      args["dry-run"]      === true || args["dry-run"] === "true",
  };

  const missing = ["wallet", "from", "to", "amount"].filter((k) => !params[k]);
  if (missing.length) {
    console.error(`Missing required args: ${missing.map((k) => `--${k}`).join(", ")}`);
    process.exit(1);
  }

  rebalance(params)
    .then((r) => { console.log(JSON.stringify(r, null, 2)); setTimeout(() => process.exit(0), 500); })
    .catch((e) => { console.error(`\n❌ Rebalance failed: ${e.message}`); setTimeout(() => process.exit(1), 500); });
}

export { rebalance };
