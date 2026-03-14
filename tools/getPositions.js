/**
 * tools/solana/getPositions.js
 * Read-only: fetches a wallet's Solana staking and lending positions.
 *
 * Covers:
 *   - Native SOL balance
 *   - Native stake accounts (delegated to validators)
 *   - Liquid staking tokens: mSOL, JitoSOL, bSOL, stSOL, INF
 *   - MarginFi lending positions (via MarginFi API)
 *   - Kamino lending obligations (via Kamino API)
 *
 * Read-only — no private key needed.
 */

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  StakeProgram,
} from "@solana/web3.js";

// ─── RPC ─────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

function getConnection() {
  return new Connection(RPC_URL, "confirmed");
}

// ─── Liquid staking token registry ───────────────────────────────────────────

const LIQUID_STAKING_TOKENS = [
  {
    symbol:   "mSOL",
    protocol: "Marinade",
    mint:     "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    decimals: 9,
  },
  {
    symbol:   "JitoSOL",
    protocol: "Jito",
    mint:     "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    decimals: 9,
  },
  {
    symbol:   "bSOL",
    protocol: "BlazeStake",
    mint:     "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    decimals: 9,
  },
  {
    symbol:   "stSOL",
    protocol: "Lido",
    mint:     "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",
    decimals: 9,
  },
  {
    symbol:   "INF",
    protocol: "Sanctum Infinity",
    mint:     "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
    decimals: 9,
  },
  {
    symbol:   "LST",
    protocol: "Sanctum",
    mint:     "LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp",
    decimals: 9,
  },
  {
    symbol:   "jupSOL",
    protocol: "Jupiter",
    mint:     "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
    decimals: 9,
  },
];

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// ─── Native SOL ───────────────────────────────────────────────────────────────

async function getNativeSolBalance(connection, walletPubkey) {
  const lamports = await connection.getBalance(walletPubkey);
  const sol      = lamports / LAMPORTS_PER_SOL;
  if (sol < 0.001) return null; // ignore dust

  return {
    protocol:  "Native",
    type:      "wallet",
    symbol:    "SOL",
    underlying:"SOL",
    amount:    sol,
    chain:     "Solana",
    note:      "Unstaked SOL in wallet",
  };
}

// ─── Native stake accounts ────────────────────────────────────────────────────

/**
 * Finds all native stake accounts where the wallet is the stake authority.
 * Stake accounts hold SOL delegated to a validator.
 *
 * Layout (parsed): meta.authorized.staker / meta.authorized.withdrawer
 */
async function getNativeStakePositions(connection, walletPubkey) {
  const walletBase58 = walletPubkey.toBase58();

  const accounts = await connection.getParsedProgramAccounts(
    StakeProgram.programId,
    {
      filters: [
        // staker authority is at byte offset 44 in the raw stake account
        {
          memcmp: {
            offset: 44,
            bytes:  walletBase58,
          },
        },
      ],
    }
  );

  const positions = [];

  for (const { pubkey, account } of accounts) {
    const parsed = account.data?.parsed;
    if (!parsed) continue;

    const { type, info } = parsed;
    const lamports = account.lamports;
    const sol      = lamports / LAMPORTS_PER_SOL;

    if (sol < 0.001) continue;

    const validator = info?.stake?.delegation?.voter ?? null;
    const status    = type === "delegated"
      ? (info?.stake?.delegation?.deactivationEpoch === "18446744073709551615" ? "active" : "deactivating")
      : type; // "initialized", "deactivated"

    positions.push({
      protocol:        "Native Staking",
      type:            "stake",
      symbol:          "SOL",
      underlying:      "SOL",
      amount:          sol,
      chain:           "Solana",
      stakeAccount:    pubkey.toBase58(),
      validator,
      status,
    });
  }

  return positions;
}

// ─── Liquid staking SPL tokens ────────────────────────────────────────────────

/**
 * Finds all liquid staking token balances (mSOL, JitoSOL, etc.) in the wallet.
 * Uses getTokenAccountsByOwner for each mint.
 */
async function getLiquidStakingPositions(connection, walletPubkey) {
  // Fetch all SPL token accounts in one call
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    walletPubkey,
    { programId: TOKEN_PROGRAM_ID }
  );

  const mintToBalance = {};
  for (const { account } of tokenAccounts.value) {
    const info   = account.data.parsed.info;
    const mint   = info.mint;
    const amount = parseFloat(info.tokenAmount.uiAmountString ?? "0");
    if (amount > 0) mintToBalance[mint] = amount;
  }

  const positions = [];

  for (const token of LIQUID_STAKING_TOKENS) {
    const amount = mintToBalance[token.mint];
    if (!amount || amount < 0.000001) continue;

    positions.push({
      protocol:   token.protocol,
      type:       "liquid-stake",
      symbol:     token.symbol,
      underlying: "SOL",
      amount,
      mint:       token.mint,
      chain:      "Solana",
    });
  }

  return positions;
}

// ─── MarginFi lending ─────────────────────────────────────────────────────────

/**
 * Fetches MarginFi account data via their public API.
 * Returns lending (deposit) positions.
 */
async function getMarginFiPositions(walletAddress) {
  try {
    const url = `https://production.marginfi.com/v1/user/${walletAddress}/balances`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) return [];

    const data = await res.json();
    const positions = [];

    for (const balance of (data.balances ?? [])) {
      if (!balance.active) continue;

      const depositAmount = parseFloat(balance.assetShares ?? 0);
      if (depositAmount <= 0) continue;

      positions.push({
        protocol:   "MarginFi",
        type:       "lend",
        symbol:     balance.bankSymbol ?? balance.mint,
        underlying: balance.bankSymbol ?? balance.mint,
        amount:     depositAmount,
        chain:      "Solana",
        bankAddress: balance.bank,
      });
    }
    return positions;
  } catch {
    // MarginFi API unavailable — skip silently
    return [];
  }
}

// ─── Kamino lending ───────────────────────────────────────────────────────────

/**
 * Fetches Kamino obligations via their public API.
 */
async function getKaminoPositions(walletAddress) {
  try {
    const url = `https://api.kamino.finance/v2/users/${walletAddress}/obligations`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) return [];

    const data = await res.json();
    const positions = [];

    for (const obligation of (Array.isArray(data) ? data : [])) {
      for (const deposit of (obligation.deposits ?? [])) {
        const amount = parseFloat(deposit.amount ?? 0);
        if (amount <= 0) continue;

        positions.push({
          protocol:   "Kamino",
          type:       "lend",
          symbol:     deposit.symbol ?? deposit.mint,
          underlying: deposit.symbol ?? deposit.mint,
          amount,
          chain:      "Solana",
          market:     obligation.lendingMarket,
        });
      }
    }
    return positions;
  } catch {
    return [];
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Returns all Solana staking and lending positions for a wallet.
 *
 * @param {string} walletAddress  – base58 Solana public key
 * @param {object} [opts]
 * @param {boolean} [opts.native=true]        – include native SOL balance
 * @param {boolean} [opts.nativeStake=true]   – include native stake accounts
 * @param {boolean} [opts.liquidStaking=true] – include mSOL, JitoSOL, etc.
 * @param {boolean} [opts.marginfi=true]      – include MarginFi deposits
 * @param {boolean} [opts.kamino=true]        – include Kamino lending
 * @returns {Promise<PositionResult>}
 */
async function getPositions(walletAddress, opts = {}) {
  const {
    native        = true,
    nativeStake   = true,
    liquidStaking = true,
    marginfi      = true,
    kamino        = true,
  } = opts;

  let walletPubkey;
  try {
    walletPubkey = new PublicKey(walletAddress);
  } catch {
    throw new Error(`Invalid Solana address: "${walletAddress}"`);
  }

  const connection = getConnection();

  const [
    nativePos,
    stakePositions,
    lstPositions,
    marginFiPositions,
    kaminoPositions,
  ] = await Promise.all([
    native        ? getNativeSolBalance(connection, walletPubkey)         : null,
    nativeStake   ? getNativeStakePositions(connection, walletPubkey)     : [],
    liquidStaking ? getLiquidStakingPositions(connection, walletPubkey)   : [],
    marginfi      ? getMarginFiPositions(walletAddress)                   : [],
    kamino        ? getKaminoPositions(walletAddress)                     : [],
  ]);

  const all = [
    ...(nativePos ? [nativePos] : []),
    ...stakePositions,
    ...lstPositions,
    ...marginFiPositions,
    ...kaminoPositions,
  ];

  // Total staked SOL (native + LSTs)
  const totalStakedSol = all
    .filter((p) => p.underlying === "SOL" && p.type !== "wallet")
    .reduce((s, p) => s + p.amount, 0);

  return {
    wallet:    walletAddress,
    chain:     "Solana",
    timestamp: new Date().toISOString(),
    positions: all,
    summary: {
      totalPositions: all.length,
      totalStakedSol: parseFloat(totalStakedSol.toFixed(4)),
      byProtocol: Object.entries(
        all.reduce((acc, p) => {
          acc[p.protocol] = (acc[p.protocol] ?? 0) + 1;
          return acc;
        }, {})
      ).map(([protocol, count]) => ({ protocol, count })),
    },
  };
}

export {
  getPositions,
  getNativeSolBalance,
  getNativeStakePositions,
  getLiquidStakingPositions,
  getMarginFiPositions,
  getKaminoPositions,
};
