/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { ServerlessMysql } from 'serverless-mysql';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { Network } from '@hathor/wallet-lib';
// Mocks the alerting module by resolved file, so both the worker's subpath
// import and the recovery engine's barrel import land on the same stub.
import { mockedAddAlert } from '@tests/utils/alerting.utils.mock';
import { Bip32Account } from '@wallet-service/common';
import { deriveCtAddress } from '@wallet-service/common/src/crypto/shieldedAddress';
import { getDbConnection, getWalletId, closeDbConnection } from '@src/utils';
import {
  cleanDatabase, XPUBKEY, AUTH_XPUBKEY, ADDRESSES,
  addToAddressTxHistoryTable, addToAddressBalanceTable, checkWalletBalanceTable,
} from '@tests/utils';
import { resetCtCryptoMock, primeAmountRewind } from '@tests/utils/ct-crypto-mock';
import { loadWallet } from '@src/api/wallet';
import * as Db from '@src/db';
import { createWallet, getWallet, updateWalletStatus } from '@src/db';
import { DbSelectResult, WalletStatus } from '@src/types';

const mysql: ServerlessMysql = getDbConnection();
const COMBINED_TEST_TIMEOUT_MS = 30000; // real BIP32 derivation across gap blocks is slow

const bip32lib = BIP32Factory(ecc);
const root = bip32lib.fromSeed(Buffer.from('03'.repeat(32), 'hex'));
const scanXpriv = root.derivePath("m/44'/280'/1'/0").toBase58();
const spendXpub = root.derivePath("m/44'/280'/2'/0").neutered().toBase58();
const net = new Network(process.env.NETWORK as string);
const derivedAt = (i: number) => deriveCtAddress(scanXpriv, spendXpub, i, net);

const walletId = getWalletId(XPUBKEY);
const MAX_GAP = 5;      // transparent gap for the test event
const SHIELDED_GAP = 5; // wallet.shielded_max_gap

const seedShieldedOutputAt = async (index: number, txId: string, marker: number, value: bigint) => {
  const { spendAddress } = derivedAt(index);
  await mysql.query(
    `INSERT INTO \`tx_output\`
       (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
        \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`mode\`, \`recovery_state\`)
     VALUES (?, 0, ?, NULL, '00', 0, NULL, NULL, FALSE, FALSE, 1, 'unowned')`,
    [txId, spendAddress],
  );
  await mysql.query(
    `INSERT INTO \`shielded_tx_output_data\`
       (\`tx_id\`, \`index\`, \`commitment\`, \`range_proof\`, \`script\`, \`ephemeral_pubkey\`, \`asset_commitment\`)
     VALUES (?, 0, ?, ?, ?, ?, NULL)`,
    [txId, Buffer.alloc(33, marker), Buffer.alloc(8), Buffer.alloc(1), Buffer.alloc(33, marker)],
  );
  await mysql.query(
    'INSERT INTO `transaction` (`tx_id`, `timestamp`, `version`, `voided`) VALUES (?, 1000, 1, FALSE)', [txId],
  );
  primeAmountRewind({
    commitment: Buffer.alloc(33, marker),
    ephemeralPubkey: Buffer.alloc(33, marker),
    value,
    tokenUid: Buffer.from('00', 'hex'),
  });
};

const runWorker = (event: Record<string, unknown>) => (
  loadWallet(event as never, null as never, null as never)
);

beforeEach(async () => {
  await cleanDatabase(mysql);
  resetCtCryptoMock();
  mockedAddAlert.mockClear();
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

describe('loadWallet', () => {
  it('loads a fresh shielded wallet end-to-end: claims, recovers, credits, flips ready', async () => {
    await createWallet(mysql, walletId, XPUBKEY, AUTH_XPUBKEY, MAX_GAP, { scanXpriv, spendXpub, shieldedMaxGap: SHIELDED_GAP });
    await seedShieldedOutputAt(2, 'ctx1', 0xa1, 1500n);

    const result = await runWorker({ xpubkey: XPUBKEY, maxGap: MAX_GAP });
    expect(result).toMatchObject({ success: true, walletId });

    // shielded window claimed: usage at 2 -> rows 0..7, all done, real keys stored
    const ctRows: DbSelectResult = await mysql.query(
      'SELECT `index`, `catchup_state`, `ct_address`, `scan_privkey` FROM `address` WHERE `wallet_id` = ? AND `bip32_account` = ? ORDER BY `index`',
      [walletId, Bip32Account.CTSpend],
    );
    expect(ctRows).toHaveLength(2 + SHIELDED_GAP + 1);
    expect(ctRows.every((r) => r.catchup_state === 'done')).toBe(true);
    expect(ctRows[2].ct_address).toBe(derivedAt(2).ctAddress);
    expect(Buffer.from(ctRows[2].scan_privkey as Buffer).equals(derivedAt(2).scanPrivkey)).toBe(true);

    // output recovered and credited to the wallet's shielded balance
    const out = (await mysql.query('SELECT `recovery_state`, `value` FROM `tx_output` WHERE `tx_id` = ?', ['ctx1']))[0];
    expect(out.recovery_state).toBe('recovered');
    expect(String(out.value)).toBe('1500');
    const wb = (await mysql.query(
      "SELECT `unlocked_shielded_balance` AS usb FROM `wallet_balance` WHERE `wallet_id` = ? AND `token_id` = '00'", [walletId],
    ))[0];
    expect(String(wb.usb)).toBe('1500');

    // wallet finalized
    const w = await getWallet(mysql, walletId);
    expect(w.status).toBe(WalletStatus.READY);
    expect(w.ctStatus).toBe(WalletStatus.READY);
    expect(w.retryCount).toBe(0);
    expect(w.lastUsedShieldedIndex).toBe(2);
    // transparent window claimed too (no transparent usage -> maxGap rows)
    const tCount = (await mysql.query(
      'SELECT COUNT(*) AS c FROM `address` WHERE `wallet_id` = ? AND (`bip32_account` IS NULL OR `bip32_account` = 0)', [walletId],
    ))[0];
    expect(Number(tCount.c)).toBe(MAX_GAP);
  }, COMBINED_TEST_TIMEOUT_MS);

  it('is idempotent: a second run converges without double-crediting', async () => {
    await createWallet(mysql, walletId, XPUBKEY, AUTH_XPUBKEY, MAX_GAP, { scanXpriv, spendXpub, shieldedMaxGap: SHIELDED_GAP });
    await seedShieldedOutputAt(0, 'ctx2', 0xb2, 700n);

    await runWorker({ xpubkey: XPUBKEY, maxGap: MAX_GAP });
    const result2 = await runWorker({ xpubkey: XPUBKEY, maxGap: MAX_GAP });
    expect(result2).toMatchObject({ success: true });

    const wb = (await mysql.query(
      "SELECT `unlocked_shielded_balance` AS usb FROM `wallet_balance` WHERE `wallet_id` = ? AND `token_id` = '00'", [walletId],
    ))[0];
    expect(String(wb.usb)).toBe('700'); // not 1400

    const w = await getWallet(mysql, walletId);
    expect(w.status).toBe(WalletStatus.READY);
    expect(w.ctStatus).toBe(WalletStatus.READY);
  }, COMBINED_TEST_TIMEOUT_MS);

  it('keeps the transparent side untouched when a shielded upgrade fails', async () => {
    await createWallet(mysql, walletId, XPUBKEY, AUTH_XPUBKEY, MAX_GAP);
    await updateWalletStatus(mysql, walletId, WalletStatus.READY);
    // register keys, then corrupt the stored scan xpriv so derivation throws
    await mysql.query(
      'UPDATE `wallet` SET `scan_xpriv` = ?, `spend_xpub` = ?, `shielded_max_gap` = ?, `ct_status` = ? WHERE `id` = ?',
      [Buffer.from('not-a-valid-xpriv', 'utf8'), spendXpub, SHIELDED_GAP, 'creating', walletId],
    );

    const result = await runWorker({ xpubkey: XPUBKEY, maxGap: MAX_GAP });
    expect(result).toMatchObject({ success: false });

    const w = await getWallet(mysql, walletId);
    expect(w.status).toBe(WalletStatus.READY);   // upgrade: untouched
    expect(w.ctStatus).toBe(WalletStatus.ERROR);
    expect(w.retryCount).toBe(1);
    expect(mockedAddAlert).toHaveBeenCalled();   // caught failures alert
  }, COMBINED_TEST_TIMEOUT_MS);

  it('marks both sides on a fresh-load failure', async () => {
    await createWallet(mysql, walletId, XPUBKEY, AUTH_XPUBKEY, MAX_GAP, { scanXpriv: 'garbage', spendXpub, shieldedMaxGap: SHIELDED_GAP });

    const result = await runWorker({ xpubkey: XPUBKEY, maxGap: MAX_GAP });
    expect(result).toMatchObject({ success: false });
    const w = await getWallet(mysql, walletId);
    expect(w.status).toBe(WalletStatus.ERROR);
    expect(w.ctStatus).toBe(WalletStatus.ERROR);
    expect(w.retryCount).toBe(1);
  }, COMBINED_TEST_TIMEOUT_MS);

  it('behaves as a transparent-only load for a wallet without shielded keys', async () => {
    await createWallet(mysql, walletId, XPUBKEY, AUTH_XPUBKEY, MAX_GAP);

    const result = await runWorker({ xpubkey: XPUBKEY, maxGap: MAX_GAP });
    expect(result).toMatchObject({ success: true });
    const w = await getWallet(mysql, walletId);
    expect(w.status).toBe(WalletStatus.READY);
    expect(w.ctStatus).toBe('none'); // no fabricated shielded lifecycle
    const ctCount = (await mysql.query(
      'SELECT COUNT(*) AS c FROM `address` WHERE `wallet_id` = ? AND `bip32_account` = ?', [walletId, Bip32Account.CTSpend],
    ))[0];
    expect(Number(ctCount.c)).toBe(0);
  }, COMBINED_TEST_TIMEOUT_MS);

  it('reconstructs transparent balance and history for a wallet without shielded keys', async () => {
    // Golden parity check for the transparent-only path, standing in for the
    // deleted deprecated load: seed real derived addresses with multi-token,
    // voided, and cross-address-shared-tx activity, then assert exact
    // wallet_balance / wallet_tx_history output.
    const T_HTR = '00';
    const T_B = 'aa';
    await createWallet(mysql, walletId, XPUBKEY, AUTH_XPUBKEY, MAX_GAP);

    await addToAddressTxHistoryTable(mysql, [
      // ptxA is shared across two of the wallet's addresses (same token) — the
      // wallet-level row must SUM them and count the tx once.
      { address: ADDRESSES[0], txId: 'ptxA', tokenId: T_HTR, balance: 100n, timestamp: 10 },
      { address: ADDRESSES[1], txId: 'ptxA', tokenId: T_HTR, balance: 50n, timestamp: 10 },
      { address: ADDRESSES[0], txId: 'ptxB', tokenId: T_HTR, balance: -30n, timestamp: 20 },
      // ptxC is voided — must be excluded from balance, tx count, and history.
      { address: ADDRESSES[0], txId: 'ptxC', tokenId: T_HTR, balance: 999n, timestamp: 25, voided: true },
      { address: ADDRESSES[1], txId: 'ptxD', tokenId: T_B, balance: 7n, timestamp: 40 },
    ]);
    await addToAddressBalanceTable(mysql, [
      // address, token, unlocked, locked, timelock, transactions, uAuth, lAuth, total_received
      [ADDRESSES[0], T_HTR, 70, 0, null, 2, 0, 0, 100],
      [ADDRESSES[1], T_HTR, 50, 0, null, 1, 0, 0, 50],
      [ADDRESSES[1], T_B, 7, 0, null, 1, 0, 0, 7],
    ]);

    const result = await runWorker({ xpubkey: XPUBKEY, maxGap: MAX_GAP });
    expect(result).toMatchObject({ success: true, walletId });

    const w = await getWallet(mysql, walletId);
    expect(w.status).toBe(WalletStatus.READY);
    expect(w.ctStatus).toBe('none');

    // wallet_balance: summed per token across the wallet's addresses; tx count is
    // DISTINCT non-voided tx_id from history (ptxC excluded).
    expect(await checkWalletBalanceTable(mysql, 2, walletId, T_HTR, 120n, 0n, null, 2)).toBe(true);
    expect(await checkWalletBalanceTable(mysql, 2, walletId, T_B, 7n, 0n, null, 1)).toBe(true);
    const balances: DbSelectResult = await mysql.query(
      'SELECT `token_id`, `total_received` FROM `wallet_balance` WHERE `wallet_id` = ? ORDER BY `token_id`', [walletId],
    );
    expect(balances.map((r) => [r.token_id, String(r.total_received)])).toEqual([[T_HTR, '150'], [T_B, '7']]);

    // wallet_tx_history: one row per (tx_id, token); voided tx absent.
    const history: DbSelectResult = await mysql.query(
      'SELECT `tx_id`, `token_id`, `balance`, `timestamp` FROM `wallet_tx_history` WHERE `wallet_id` = ? ORDER BY `timestamp`, `token_id`',
      [walletId],
    );
    expect(history.map((r) => [r.tx_id, r.token_id, String(r.balance), Number(r.timestamp)])).toEqual([
      ['ptxA', T_HTR, '150', 10],
      ['ptxB', T_HTR, '-30', 20],
      ['ptxD', T_B, '7', 40],
    ]);
  }, COMBINED_TEST_TIMEOUT_MS);

  it('marks a transparent-only wallet error and bumps retryCount on load failure', async () => {
    await createWallet(mysql, walletId, XPUBKEY, AUTH_XPUBKEY, MAX_GAP);
    const spy = jest.spyOn(Db, 'generateAddresses').mockRejectedValueOnce(new Error('derivation boom'));

    const result = await runWorker({ xpubkey: XPUBKEY, maxGap: MAX_GAP });
    expect(result).toMatchObject({ success: false });
    const w = await getWallet(mysql, walletId);
    expect(w.status).toBe(WalletStatus.ERROR);
    expect(w.retryCount).toBe(1);
    spy.mockRestore();
  }, COMBINED_TEST_TIMEOUT_MS);

  it('short-circuits warmup events', async () => {
    const r = await runWorker({ source: 'serverless-plugin-warmup' });
    expect(r).toMatchObject({ success: true, walletId: '' });
  });
});
