/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ServerlessMysql } from 'serverless-mysql';
import { Bip32Account, RecoveryState, ShieldedOutputMode } from '@wallet-service/common';
import { deriveCtAddress } from '@wallet-service/common/src/crypto/shieldedAddress';
import type { Network } from '@hathor/wallet-lib';
import { DbSelectResult } from '@src/types';

// The two shielded output modes (AmountShielded, FullyShielded) as query params.
const SHIELDED_MODES = [ShieldedOutputMode.AmountShielded, ShieldedOutputMode.FullyShielded];

export interface ShieldedAddressOwnership {
  walletId: string;
  shieldedIndex: number;
  scanPrivkey: Buffer;
}

/**
 * Resolve the CTSpend ownership (wallet + per-index scan key) for a shielded
 * spend address. Returns null unless a wallet has claimed the address and its
 * scan key is recorded.
 */
export const findShieldedAddressOwnership = async (
  mysql: ServerlessMysql,
  address: string,
): Promise<ShieldedAddressOwnership | null> => {
  const results: DbSelectResult = await mysql.query(
    `SELECT \`wallet_id\`, \`index\` AS \`shielded_index\`, \`scan_privkey\`
       FROM \`address\`
      WHERE \`address\` = ?
        AND \`bip32_account\` = ?
        AND \`wallet_id\` IS NOT NULL
        AND \`scan_privkey\` IS NOT NULL`,
    [address, Bip32Account.CTSpend],
  );
  if (results.length === 0) return null;
  const row = results[0];
  return {
    walletId: row.wallet_id as string,
    shieldedIndex: row.shielded_index as number,
    scanPrivkey: row.scan_privkey as Buffer,
  };
};

/**
 * Batch variant of {@link findShieldedAddressOwnership}. One query regardless of
 * list size; the returned Map is keyed by address and omits unclaimed misses.
 */
export const findShieldedAddressOwnershipBatch = async (
  mysql: ServerlessMysql,
  addresses: string[],
): Promise<Map<string, ShieldedAddressOwnership>> => {
  const ownership = new Map<string, ShieldedAddressOwnership>();
  if (addresses.length === 0) return ownership;
  const results: DbSelectResult = await mysql.query(
    `SELECT \`address\`, \`wallet_id\`, \`index\` AS \`shielded_index\`, \`scan_privkey\`
       FROM \`address\`
      WHERE \`address\` IN (?)
        AND \`bip32_account\` = ?
        AND \`wallet_id\` IS NOT NULL
        AND \`scan_privkey\` IS NOT NULL`,
    [addresses, Bip32Account.CTSpend],
  );
  for (const row of results) {
    ownership.set(row.address as string, {
      walletId: row.wallet_id as string,
      shieldedIndex: row.shielded_index as number,
      scanPrivkey: row.scan_privkey as Buffer,
    });
  }
  return ownership;
};

/**
 * Promote a shielded `tx_output` to `recovered`, filling the revealed value and
 * token id. Guarded on the row being anything but already `recovered`, so it
 * drives an `unowned` (catch-up) or `recovery_failed` (re-drive) row alike and a
 * repeat on an already-recovered row is a no-op (`affectedRows = 0`).
 */
export const markShieldedTxOutputRecovered = async (
  mysql: ServerlessMysql,
  txId: string,
  index: number,
  recovered: { value: bigint; tokenId: string },
): Promise<{ affectedRows: number }> => {
  const result = await mysql.query(
    `UPDATE \`tx_output\`
        SET \`value\` = ?, \`token_id\` = ?, \`recovery_state\` = ?
      WHERE \`tx_id\` = ? AND \`index\` = ? AND \`recovery_state\` <> ?`,
    [recovered.value.toString(), recovered.tokenId, RecoveryState.Recovered, txId, index, RecoveryState.Recovered],
  ) as unknown as { affectedRows: number };
  return { affectedRows: result.affectedRows };
};

/**
 * Record that a rewind we expected to succeed threw. Guarded on the row not
 * already being `recovered`, and leaves it `recovery_failed` so the on-call
 * sweep can always find it — it is never silently downgraded to `unowned`.
 */
export const markShieldedTxOutputRecoveryFailed = async (
  mysql: ServerlessMysql,
  txId: string,
  index: number,
): Promise<void> => {
  await mysql.query(
    `UPDATE \`tx_output\`
        SET \`recovery_state\` = ?
      WHERE \`tx_id\` = ? AND \`index\` = ? AND \`recovery_state\` <> ?`,
    [RecoveryState.RecoveryFailed, txId, index, RecoveryState.Recovered],
  );
};

/** A shielded output pending recovery, joined to its scan key and on-chain crypto bytes. */
export interface ShieldedOutputToRecover {
  txId: string;
  index: number;
  address: string;
  /** 1 = AmountShielded (token known), 2 = FullyShielded (token recovered by rewind). */
  mode: number;
  /** Set for AmountShielded at observe time; NULL for FullyShielded until recovered. */
  tokenId: string | null;
  scanPrivkey: Buffer;
  ephemeralPubkey: Buffer;
  commitment: Buffer;
  rangeProof: Buffer;
  /** Present only for FullyShielded (mode 2). */
  assetCommitment: Buffer | null;
}

/**
 * Read a page of the wallet's not-yet-recovered shielded outputs (`unowned` or
 * `recovery_failed` alike), joined to the per-index scan key (`address`) and the
 * on-chain crypto bytes (`shielded_tx_output_data`) needed to rewind them. So a
 * catch-up re-drives previously-failed outputs too, and failed ones are never
 * downgraded to `unowned`. Ordered by (tx_id, index) so pagination is stable.
 */
export const getShieldedOutputsToRecover = async (
  mysql: ServerlessMysql,
  walletId: string,
  limit: number,
  after?: { txId: string; index: number },
): Promise<ShieldedOutputToRecover[]> => {
  // Keyset cursor on (tx_id, index): because a re-driven `recovery_failed` row
  // stays in the result set, plain re-querying would revisit it — advancing past
  // the last row seen guarantees forward progress.
  const cursor = after ? 'AND (t.`tx_id` > ? OR (t.`tx_id` = ? AND t.`index` > ?))' : '';
  // Placeholder order follows the SQL text: join account, wallet, the two shielded
  // modes, the recovered-guard, then (optional) cursor keys, then limit.
  const head = [Bip32Account.CTSpend, walletId, ...SHIELDED_MODES, RecoveryState.Recovered];
  const params = after
    ? [...head, after.txId, after.txId, after.index, limit]
    : [...head, limit];
  const results: DbSelectResult = await mysql.query(
    `SELECT t.\`tx_id\` AS tx_id, t.\`index\` AS \`index\`, t.\`address\` AS address,
            t.\`mode\` AS mode, t.\`token_id\` AS token_id,
            a.\`scan_privkey\` AS scan_privkey,
            d.\`ephemeral_pubkey\` AS ephemeral_pubkey, d.\`commitment\` AS commitment,
            d.\`range_proof\` AS range_proof, d.\`asset_commitment\` AS asset_commitment
       FROM \`tx_output\` t
       INNER JOIN \`shielded_tx_output_data\` d
         ON d.\`tx_id\` = t.\`tx_id\` AND d.\`index\` = t.\`index\`
       INNER JOIN \`address\` a
         ON a.\`address\` = t.\`address\` AND a.\`bip32_account\` = ?
      WHERE a.\`wallet_id\` = ?
        AND a.\`scan_privkey\` IS NOT NULL
        AND t.\`mode\` IN (?, ?)
        AND t.\`voided\` = FALSE
        AND t.\`recovery_state\` <> ?
        ${cursor}
      ORDER BY t.\`tx_id\`, t.\`index\`
      LIMIT ?`,
    params,
  );
  return results.map((row) => ({
    txId: row.tx_id as string,
    index: row.index as number,
    address: row.address as string,
    mode: row.mode as number,
    tokenId: (row.token_id ?? null) as string | null,
    scanPrivkey: row.scan_privkey as Buffer,
    ephemeralPubkey: row.ephemeral_pubkey as Buffer,
    commitment: row.commitment as Buffer,
    rangeProof: row.range_proof as Buffer,
    assetCommitment: (row.asset_commitment ?? null) as Buffer | null,
  }));
};

/**
 * Recompute the shielded balance columns of `address_balance` for the given
 * addresses from their recovered `tx_output` rows (mode 1/2, `recovery_state =
 * 'recovered'`, non-voided). Snapshot semantics (replace, not add) → idempotent:
 * unlocked/locked come from the unspent utxos, `total_shielded_received` is the
 * lifetime (every recovered output, spent or not). Only the shielded columns are
 * written; a transparent balance already on the (address, token) row is preserved.
 */
export const rebuildShieldedAddressBalances = async (
  mysql: ServerlessMysql,
  addresses: string[],
): Promise<void> => {
  if (addresses.length === 0) return;
  await mysql.query(
    `INSERT INTO \`address_balance\`
       (\`address\`, \`token_id\`, \`unlocked_balance\`, \`locked_balance\`,
        \`unlocked_shielded_balance\`, \`locked_shielded_balance\`, \`total_shielded_received\`,
        \`unlocked_authorities\`, \`locked_authorities\`, \`transactions\`)
     SELECT t.\`address\`, t.\`token_id\`, 0, 0,
        COALESCE(SUM(CASE WHEN t.\`spent_by\` IS NULL AND t.\`locked\` = FALSE THEN t.\`value\` ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN t.\`spent_by\` IS NULL AND t.\`locked\` = TRUE  THEN t.\`value\` ELSE 0 END), 0),
        COALESCE(SUM(t.\`value\`), 0),
        0, 0, 0
       FROM \`tx_output\` t
      WHERE t.\`address\` IN (?) AND t.\`mode\` IN (?, ?)
        AND t.\`recovery_state\` = ? AND t.\`voided\` = FALSE
      GROUP BY t.\`address\`, t.\`token_id\`
     ON DUPLICATE KEY UPDATE
        \`unlocked_shielded_balance\` = VALUES(\`unlocked_shielded_balance\`),
        \`locked_shielded_balance\` = VALUES(\`locked_shielded_balance\`),
        \`total_shielded_received\` = VALUES(\`total_shielded_received\`)`,
    [addresses, ...SHIELDED_MODES, RecoveryState.Recovered],
  );
};

/**
 * Recompute the shielded receive-history for the given addresses from their
 * recovered `tx_output` rows: one signed `shielded_balance_delta` per (address,
 * tx, token), summed across that tx's recovered outputs, stamped with the tx
 * timestamp. Replace-not-add (`= VALUES(...)`) → idempotent, and only the shielded
 * delta is written, so a transparent `balance` already on that history row is kept.
 *
 * This is the receive side only; a shielded output later spent has its negative
 * delta produced by the spend tx, which a receive-driven catch-up does not see.
 */
export const rebuildShieldedAddressTxHistory = async (
  mysql: ServerlessMysql,
  addresses: string[],
): Promise<void> => {
  if (addresses.length === 0) return;
  await mysql.query(
    `INSERT INTO \`address_tx_history\`
       (\`address\`, \`tx_id\`, \`token_id\`, \`balance\`, \`shielded_balance_delta\`, \`timestamp\`, \`voided\`)
     SELECT t.\`address\`, t.\`tx_id\`, t.\`token_id\`, 0,
        COALESCE(SUM(t.\`value\`), 0), tx.\`timestamp\`, FALSE
       FROM \`tx_output\` t
       INNER JOIN \`transaction\` tx ON tx.\`tx_id\` = t.\`tx_id\`
      WHERE t.\`address\` IN (?) AND t.\`mode\` IN (?, ?)
        AND t.\`recovery_state\` = ? AND t.\`voided\` = FALSE
      GROUP BY t.\`address\`, t.\`tx_id\`, t.\`token_id\`, tx.\`timestamp\`
     ON DUPLICATE KEY UPDATE \`shielded_balance_delta\` = VALUES(\`shielded_balance_delta\`)`,
    [addresses, ...SHIELDED_MODES, RecoveryState.Recovered],
  );
};

/**
 * Rebuild a wallet's `wallet_balance` rows by aggregating its addresses'
 * `address_balance` (both transparent and shielded column families), with the
 * per-token `transactions` count taken from `address_tx_history` (distinct txs,
 * so shared txs aren't double-counted). Upsert → idempotent. Credits the
 * transparent balance and any caught-up shielded receives in the same pass, so
 * it serves both transparent-only and shielded wallets.
 */
export const rebuildWalletBalance = async (
  mysql: ServerlessMysql,
  walletId: string,
  addresses: string[],
): Promise<void> => {
  if (addresses.length === 0) return;
  await mysql.query(
    `INSERT INTO \`wallet_balance\`
       (\`wallet_id\`, \`token_id\`, \`total_received\`, \`unlocked_balance\`, \`locked_balance\`,
        \`timelock_expires\`, \`unlocked_authorities\`, \`locked_authorities\`, \`transactions\`,
        \`unlocked_shielded_balance\`, \`locked_shielded_balance\`, \`total_shielded_received\`)
     SELECT ?, b.\`token_id\`, b.\`total_received\`, b.\`unlocked_balance\`, b.\`locked_balance\`,
        b.\`timelock_expires\`, b.\`unlocked_authorities\`, b.\`locked_authorities\`,
        COALESCE(h.\`transactions\`, 0),
        b.\`unlocked_shielded_balance\`, b.\`locked_shielded_balance\`, b.\`total_shielded_received\`
       FROM (
         SELECT \`token_id\`,
                SUM(\`total_received\`) AS \`total_received\`,
                SUM(\`unlocked_balance\`) AS \`unlocked_balance\`,
                SUM(\`locked_balance\`) AS \`locked_balance\`,
                MIN(\`timelock_expires\`) AS \`timelock_expires\`,
                BIT_OR(\`unlocked_authorities\`) AS \`unlocked_authorities\`,
                BIT_OR(\`locked_authorities\`) AS \`locked_authorities\`,
                SUM(\`unlocked_shielded_balance\`) AS \`unlocked_shielded_balance\`,
                SUM(\`locked_shielded_balance\`) AS \`locked_shielded_balance\`,
                SUM(\`total_shielded_received\`) AS \`total_shielded_received\`
           FROM \`address_balance\`
          WHERE \`address\` IN (?)
          GROUP BY \`token_id\`
       ) b
       LEFT JOIN (
         SELECT \`token_id\`, COUNT(DISTINCT \`tx_id\`) AS \`transactions\`
           FROM \`address_tx_history\`
          WHERE \`address\` IN (?) AND \`voided\` = FALSE
          GROUP BY \`token_id\`
       ) h ON h.\`token_id\` = b.\`token_id\`
     ON DUPLICATE KEY UPDATE
        \`total_received\` = VALUES(\`total_received\`),
        \`unlocked_balance\` = VALUES(\`unlocked_balance\`),
        \`locked_balance\` = VALUES(\`locked_balance\`),
        \`timelock_expires\` = VALUES(\`timelock_expires\`),
        \`unlocked_authorities\` = VALUES(\`unlocked_authorities\`),
        \`locked_authorities\` = VALUES(\`locked_authorities\`),
        \`transactions\` = VALUES(\`transactions\`),
        \`unlocked_shielded_balance\` = VALUES(\`unlocked_shielded_balance\`),
        \`locked_shielded_balance\` = VALUES(\`locked_shielded_balance\`),
        \`total_shielded_received\` = VALUES(\`total_shielded_received\`)`,
    [walletId, addresses, addresses],
  );
};

/**
 * Rebuild a wallet's `wallet_tx_history` by aggregating its addresses'
 * `address_tx_history` per (tx, token): transparent `balance` and
 * `shielded_balance_delta` are summed across the wallet's addresses. Upsert →
 * idempotent. Serves both transparent-only and shielded wallets.
 */
export const rebuildWalletTxHistory = async (
  mysql: ServerlessMysql,
  walletId: string,
  addresses: string[],
): Promise<void> => {
  if (addresses.length === 0) return;
  await mysql.query(
    `INSERT INTO \`wallet_tx_history\`
       (\`wallet_id\`, \`token_id\`, \`tx_id\`, \`balance\`, \`shielded_balance_delta\`, \`timestamp\`, \`voided\`)
     SELECT ?, \`token_id\`, \`tx_id\`,
        SUM(\`balance\`), SUM(\`shielded_balance_delta\`), \`timestamp\`, FALSE
       FROM \`address_tx_history\`
      WHERE \`address\` IN (?) AND \`voided\` = FALSE
      GROUP BY \`tx_id\`, \`token_id\`, \`timestamp\`
     ON DUPLICATE KEY UPDATE
        \`balance\` = VALUES(\`balance\`),
        \`shielded_balance_delta\` = VALUES(\`shielded_balance_delta\`)`,
    [walletId, addresses],
  );
};

export interface ShieldedOwnershipRow {
  index: number;
  spendAddress: string;
  ctAddress: string;
  scanPrivkey: Buffer;
}

/**
 * Claim shielded ownership of the given derived addresses for a wallet: upsert
 * `address` rows with the CTSpend account, per-index scan privkey, display
 * ct_address and a pending catch-up state. Safe over daemon observation rows —
 * the daemon only ever writes (address, transactions), so ownership columns are
 * disjoint; `transactions` appears ONLY in the insert list (never zeroed on
 * duplicate) and a `done` catch-up state is preserved via COALESCE.
 */
export const upsertShieldedAddressOwnership = async (
  mysql: ServerlessMysql,
  walletId: string,
  rows: ShieldedOwnershipRow[],
): Promise<void> => {
  if (rows.length === 0) return;
  const values = rows.map((r) => [
    r.spendAddress, r.index, walletId, 0, Bip32Account.CTSpend, r.scanPrivkey, 'pending', r.ctAddress,
  ]);
  await mysql.query(
    `INSERT INTO \`address\`
       (\`address\`, \`index\`, \`wallet_id\`, \`transactions\`, \`bip32_account\`, \`scan_privkey\`, \`catchup_state\`, \`ct_address\`)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       \`bip32_account\` = VALUES(\`bip32_account\`),
       \`wallet_id\` = VALUES(\`wallet_id\`),
       \`index\` = VALUES(\`index\`),
       \`ct_address\` = VALUES(\`ct_address\`),
       \`scan_privkey\` = VALUES(\`scan_privkey\`),
       \`catchup_state\` = COALESCE(\`catchup_state\`, VALUES(\`catchup_state\`))`,
    [values],
  );
};

/**
 * All CTSpend addresses claimed by a wallet, in index order — the shielded half
 * of the address set a reconstruction pass must cover. Reading this back from
 * the database (rather than trusting one run's derived list) keeps re-loads
 * covering previously-claimed rows even if the usage window shrank.
 */
export const getWalletCtSpendAddresses = async (
  mysql: ServerlessMysql,
  walletId: string,
): Promise<string[]> => {
  const results: DbSelectResult = await mysql.query(
    'SELECT `address` FROM `address` WHERE `wallet_id` = ? AND `bip32_account` = ? ORDER BY `index`',
    [walletId, Bip32Account.CTSpend],
  );
  return results.map((r) => r.address as string);
};

/**
 * Mark the catch-up pass complete for a wallet's CTSpend rows up to (and
 * including) maxIndex — scoped so rows this pass did not derive are untouched.
 * NOTE: `catchup_state` records "the registration pass ran over this address";
 * re-driving unrecovered outputs is keyed on `tx_output.recovery_state`, never
 * on this column.
 */
export const markShieldedCatchupDone = async (
  mysql: ServerlessMysql,
  walletId: string,
  maxIndex: number,
): Promise<void> => {
  await mysql.query(
    'UPDATE `address` SET `catchup_state` = ? WHERE `wallet_id` = ? AND `bip32_account` = ? AND `index` <= ?',
    ['done', walletId, Bip32Account.CTSpend, maxIndex],
  );
};

export interface GenerateShieldedAddresses {
  rows: ShieldedOwnershipRow[];
  addresses: string[];
  lastUsedShieldedIndex: number | null;
  /** The subset of `rows` not yet claimed in the database — what a caller must upsert. */
  newRows: ShieldedOwnershipRow[];
}

/**
 * Derive the wallet's shielded (CTSpend) address window under the BIP32 gap
 * rule: keep deriving blocks of maxGap until maxGap consecutive trailing
 * addresses show no on-chain usage. Usage is decided from observed non-voided
 * `tx_output` rows at the derived spend address — any mode, since these P2PKH
 * addresses can also receive transparent outputs — with no rewinding involved.
 *
 * Indices the wallet already claimed are reused from storage instead of
 * re-derived: keys are immutable per wallet (a conflicting re-registration is
 * rejected upstream), so stored derivations are authoritative, and per-index
 * private derivation is the dominant CPU cost — a retry re-derives nothing.
 * Read-only: claiming the returned `newRows` is the caller's job.
 */
export const generateShieldedAddresses = async (
  mysql: ServerlessMysql,
  walletId: string,
  scanXpriv: string,
  spendXpub: string,
  maxGap: number,
  network: Network,
): Promise<GenerateShieldedAddresses> => {
  const stored: DbSelectResult = await mysql.query(
    `SELECT \`address\`, \`index\`, \`scan_privkey\`, \`ct_address\`
       FROM \`address\`
      WHERE \`wallet_id\` = ? AND \`bip32_account\` = ?
        AND \`index\` IS NOT NULL AND \`scan_privkey\` IS NOT NULL AND \`ct_address\` IS NOT NULL`,
    [walletId, Bip32Account.CTSpend],
  );
  const storedByIndex = new Map<number, ShieldedOwnershipRow>(stored.map((r): [number, ShieldedOwnershipRow] => [
    Number(r.index),
    {
      index: Number(r.index),
      spendAddress: r.address as string,
      ctAddress: r.ct_address as string,
      scanPrivkey: r.scan_privkey as Buffer,
    },
  ]));

  const allRows: ShieldedOwnershipRow[] = [];
  const derivedRows: ShieldedOwnershipRow[] = [];
  let highestCheckedIndex = -1;
  let lastUsedIndex = -1;

  do {
    const blockStart = highestCheckedIndex + 1;
    const block: ShieldedOwnershipRow[] = [];
    for (let index = blockStart; index < blockStart + maxGap; index++) {
      const storedRow = storedByIndex.get(index);
      if (storedRow) {
        block.push(storedRow);
      } else {
        const derived = deriveCtAddress(scanXpriv, spendXpub, index, network);
        const row = {
          index,
          spendAddress: derived.spendAddress,
          ctAddress: derived.ctAddress,
          scanPrivkey: derived.scanPrivkey,
        };
        block.push(row);
        derivedRows.push(row);
      }
    }
    allRows.push(...block);

    const results: DbSelectResult = await mysql.query(
      'SELECT DISTINCT `address` FROM `tx_output` WHERE `address` IN (?) AND `voided` = FALSE',
      [block.map((r) => r.spendAddress)],
    );
    const used = new Set(results.map((r) => r.address as string));
    for (const row of block) {
      if (used.has(row.spendAddress) && row.index > lastUsedIndex) {
        lastUsedIndex = row.index;
      }
    }
    highestCheckedIndex += maxGap;
  } while (lastUsedIndex + maxGap > highestCheckedIndex);

  const windowEnd = lastUsedIndex + maxGap;
  const rows = allRows.filter((r) => r.index <= windowEnd);
  return {
    rows,
    addresses: rows.map((r) => r.spendAddress),
    lastUsedShieldedIndex: lastUsedIndex === -1 ? null : lastUsedIndex,
    newRows: derivedRows.filter((r) => r.index <= windowEnd),
  };
};
