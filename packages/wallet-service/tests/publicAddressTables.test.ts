/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The public address tables are written by the daemon from on-chain data
// only. Recovering a wallet's shielded outputs here must leave them exactly
// as they were.

import { Logger } from 'winston';
import { ServerlessMysql } from 'serverless-mysql';
import { getDbConnection, closeDbConnection } from '@src/utils';
import { cleanDatabase } from '@tests/utils';
import { resetCtCryptoMock, primeAmountRewind, primeFullyRewind } from '@tests/utils/ct-crypto-mock';
import { runShieldedSweep, resetSweepMissingProviderAlert } from '@src/shieldedSweep';

jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: jest.fn().mockResolvedValue(undefined),
}));

const mysql: ServerlessMysql = getDbConnection();
const logger = { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} } as unknown as Logger;

const ADDRESS = 'ca';
const U = 'a2'.repeat(32);
const T = 'a1'.repeat(32);

const insertTx = (txId: string, timestamp: number) => mysql.query(
  'INSERT INTO `transaction` (`tx_id`, `timestamp`, `version`, `voided`) VALUES (?, ?, 1, FALSE)', [txId, timestamp],
);

// An output as the daemon stores it before any recovery.
const insertUnownedOutput = (txId: string, tokenId: string | null, mode: number, spentBy: string | null = null) => mysql.query(
  `INSERT INTO \`tx_output\`
     (\`tx_id\`, \`index\`, \`address\`, \`value\`, \`token_id\`, \`authorities\`,
      \`timelock\`, \`heightlock\`, \`locked\`, \`voided\`, \`spent_by\`, \`mode\`, \`recovery_state\`)
   VALUES (?, 0, ?, NULL, ?, 0, NULL, NULL, FALSE, FALSE, ?, ?, 'unowned')`,
  [txId, ADDRESS, tokenId, spentBy, mode],
);

const insertSatellite = (txId: string, key: number, mode: number) => mysql.query(
  `INSERT INTO \`shielded_tx_output_data\`
     (\`tx_id\`, \`index\`, \`commitment\`, \`range_proof\`, \`script\`, \`ephemeral_pubkey\`, \`asset_commitment\`)
   VALUES (?, 0, ?, ?, ?, ?, ?)`,
  [txId, Buffer.alloc(33, key), Buffer.alloc(8), Buffer.alloc(1), Buffer.alloc(33, key), mode === 2 ? Buffer.alloc(33, 0x06) : null],
);

// The rows the daemon's ingest wrote for those outputs.
const insertPublicRows = async () => {
  await mysql.query(
    `INSERT INTO \`public_address_tx_history\`
       (\`address\`, \`token_id\`, \`timestamp\`, \`tx_id\`, \`balance\`, \`has_shielded\`)
     VALUES (?, '00', 1000, 'o1', 0, TRUE), (?, 'fully_shielded', 1010, 'o2', 0, TRUE),
            (?, ?, 1020, 'o3', 0, TRUE), (?, '00', 1030, 's1', 0, TRUE)`,
    [ADDRESS, ADDRESS, ADDRESS, U, ADDRESS],
  );
  await mysql.query(
    `INSERT INTO \`public_address_tokens\`
       (\`address\`, \`token_id\`, \`transactions\`, \`shielded_transactions\`, \`last_activity\`)
     VALUES (?, '00', 2, 2, 1030), (?, 'fully_shielded', 1, 1, 1010), (?, ?, 1, 1, 1020)`,
    [ADDRESS, ADDRESS, ADDRESS, U],
  );
};

const snapshot = async () => ({
  history: await mysql.query('SELECT * FROM `public_address_tx_history` ORDER BY `address`, `token_id`, `timestamp`, `tx_id`'),
  tokens: await mysql.query('SELECT * FROM `public_address_tokens` ORDER BY `address`, `token_id`'),
});

beforeEach(async () => {
  await cleanDatabase(mysql);
  await mysql.query('DELETE FROM `shielded_tx_output_data`');
  resetCtCryptoMock();
  resetSweepMissingProviderAlert();
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

it('leaves the public address tables unchanged when a wallet\'s shielded outputs are recovered', async () => {
  // A ready wallet whose CTSpend address the daemon flagged for the sweep.
  await mysql.query(
    `INSERT INTO \`wallet\` (\`id\`, \`xpubkey\`, \`auth_xpubkey\`, \`status\`, \`ct_status\`, \`max_gap\`, \`created_at\`, \`ready_at\`)
     VALUES ('w1', 'xpub-w1', 'auth-w1', 'ready', 'ready', 20, 1, 1)`,
  );
  await mysql.query(
    `INSERT INTO \`address\` (\`address\`, \`index\`, \`wallet_id\`, \`transactions\`, \`bip32_account\`, \`scan_privkey\`, \`catchup_state\`)
     VALUES (?, 0, 'w1', 4, 2, ?, 'pending')`,
    [ADDRESS, Buffer.alloc(32, 1)],
  );
  // o1: AmountShielded HTR, spent by s1. o2: FullyShielded, token T once
  // recovered. o3: AmountShielded U.
  for (const [txId, ts] of [['o1', 1000], ['o2', 1010], ['o3', 1020], ['s1', 1030]] as const) {
    await insertTx(txId, ts);
  }
  await insertUnownedOutput('o1', '00', 1, 's1');
  await insertUnownedOutput('o2', null, 2);
  await insertUnownedOutput('o3', U, 1);
  await insertSatellite('o1', 0xa1, 1);
  await insertSatellite('o2', 0xa2, 2);
  await insertSatellite('o3', 0xa3, 1);
  await insertPublicRows();
  primeAmountRewind({
    commitment: Buffer.alloc(33, 0xa1), ephemeralPubkey: Buffer.alloc(33, 0xa1), value: 100n, tokenUid: Buffer.alloc(32, 0),
  });
  primeFullyRewind({
    commitment: Buffer.alloc(33, 0xa2), ephemeralPubkey: Buffer.alloc(33, 0xa2), value: 200n,
    tokenUid: Buffer.from(T, 'hex'), assetCommitment: Buffer.alloc(33, 0x06),
  });
  primeAmountRewind({
    commitment: Buffer.alloc(33, 0xa3), ephemeralPubkey: Buffer.alloc(33, 0xa3), value: 300n, tokenUid: Buffer.from(U, 'hex'),
  });
  const before = await snapshot();

  const outcome = await runShieldedSweep(mysql, logger, () => 10 * 60_000, '');
  expect(outcome).toMatchObject({ wallets: 1, recovered: 3, failed: 0, errored: 0 });

  // The recovery did write the tables it maintains.
  const states = await mysql.query('SELECT `tx_id`, `recovery_state` AS s, `token_id` FROM `tx_output` ORDER BY `tx_id`');
  expect(states).toEqual([
    { tx_id: 'o1', s: 'recovered', token_id: '00' },
    { tx_id: 'o2', s: 'recovered', token_id: T },
    { tx_id: 'o3', s: 'recovered', token_id: U },
  ]);
  const history = await mysql.query(
    'SELECT `token_id`, `tx_id` FROM `address_tx_history` WHERE `address` = ? ORDER BY `tx_id`', [ADDRESS],
  ) as { token_id: string; tx_id: string }[];
  expect(history.map((r) => r.tx_id)).toEqual(['o1', 'o2', 'o3', 's1']);
  expect(history.find((r) => r.tx_id === 'o2')?.token_id).toBe(T);

  expect(await snapshot()).toEqual(before);
});
