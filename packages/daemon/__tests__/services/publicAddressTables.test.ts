/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The public address tables: written at ingest from on-chain data only,
// reversed on void, identical whatever happens to shielded-output recovery,
// and reproduced exactly by the backfill.
const mockAddAlert = jest.fn();
jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: mockAddAlert,
}));

import { Connection } from 'mysql2/promise';
import * as db from '../../src/db';
import { handleUnvoidedTx, handleVertexAccepted, handleVertexRemoved, handleVoidedTx } from '../../src/services';
import logger from '../../src/logger';
import { FULLY_SHIELDED_TOKEN_ID, LRU } from '../../src/utils';
import { BACKFILL_PUBLIC_ADDRESS_TABLES_SQL, cleanDatabase, runSqlScript } from '../utils';
import { primeAmountRewind, primeFullyRewind, resetCtCryptoMock } from '../mocks/ct-crypto-node';

const X = 'WPublicTablesOwnerXXXXXXXXXXXXXXXX';
const Y = 'WPublicTablesOtherYYYYYYYYYYYYYYYY';
const Z = 'WPublicTablesNanoZZZZZZZZZZZZZZZZZ';
const WALLET = 'wallet_public_tables';
const T = 'a1'.repeat(32);
const U = 'a2'.repeat(32);
const V = 'a3'.repeat(32);
const SCRIPT = 'dqkU91U6sMdzgT3zxOtdIVGbqobP0FmIrA==';
const PARENTS = [
  '16ba3dbe424c443e571b00840ca54b9ff4cff467e10b6a15536e718e2008f952',
  '33e14cb555a96967841dcbe0f95e9eab5810481d01de8f4f73afb8cce365e869',
];
const BASE_TS = 1700000000;

const hash = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const ts = (n: number) => BASE_TS + n * 10;

let mysql: Connection;
let eventId = 50000;

interface VertexSpec {
  n: number;
  inputs?: unknown[];
  outputs?: unknown[];
  shieldedOutputs?: unknown[];
  tokens?: string[];
  headers?: unknown[];
}

const event = ({ n, inputs = [], outputs = [], shieldedOutputs = [], tokens = [], headers = [] }: VertexSpec, voided = false) => {
  eventId += 1;
  const h = hash(n);
  return {
    type: 'EVENT',
    latest_event_id: eventId + 1,
    event: {
      stream_id: 'test', network: 'mainnet', peer_id: 'test', id: eventId, timestamp: ts(n),
      type: 'NEW_VERTEX_ACCEPTED', group_id: null,
      data: {
        hash: h, nonce: 1, timestamp: ts(n), version: 1, weight: 21.5, signal_bits: 0,
        inputs, outputs, shielded_outputs: shieldedOutputs, parents: PARENTS, tokens, headers,
        token_name: null, token_symbol: null, aux_pow: null,
        metadata: { hash: h, voided_by: voided ? [h] : [], first_block: null, height: 100 },
      },
    },
  };
};
const context = (e: unknown) => ({
  socket: {}, healthcheck: {}, retryAttempt: 0, initialEventId: null,
  txCache: new LRU(100), rewardMinBlocks: 300, event: e,
} as any);
const ingest = (spec: VertexSpec) => handleVertexAccepted(context(event(spec)), undefined as any);
const voidVertex = (spec: VertexSpec) => handleVoidedTx(context(event(spec, true)));
const unvoidVertex = (spec: VertexSpec) => handleUnvoidedTx(context(event(spec)));
const removeVertex = (spec: VertexSpec) => handleVertexRemoved(context(event(spec)), undefined as any);

const transparentOut = (value: bigint, address: string, tokenData = 0) => ({
  value, script: SCRIPT, token_data: tokenData, decoded: { type: 'P2PKH', address, timelock: null },
});
const transparentIn = (txId: string, index: number, value: bigint, address: string, tokenData = 0) => ({
  tx_id: txId, index, spent_output: { mode: 0, ...transparentOut(value, address, tokenData) },
});
// Each shielded output gets its own commitment, so the mock rewinds tell them apart.
const commitment = (n: number) => `08${n.toString(16).padStart(2, '0').repeat(32)}`;
const EPHEMERAL = '05'.repeat(33);
const amountOut = (n: number, address: string, tokenData: number, timelock: number | null = null) => ({
  mode: 1,
  commitment: commitment(n),
  range_proof: Buffer.alloc(64, 0x03).toString('base64'),
  script: Buffer.alloc(20, 0x04).toString('base64'),
  ephemeral_pubkey: EPHEMERAL,
  token_data: tokenData,
  decoded: { address, timelock },
});
const fullyOut = (n: number, address: string) => ({
  mode: 2,
  commitment: commitment(n),
  range_proof: Buffer.alloc(64, 0x03).toString('base64'),
  script: Buffer.alloc(20, 0x04).toString('base64'),
  ephemeral_pubkey: EPHEMERAL,
  asset_commitment: '06'.repeat(33),
  surjection_proof: Buffer.alloc(64, 0x07).toString('base64'),
  decoded: { address },
});
const shieldedIn = (txId: string, index: number, spent: unknown) => ({ tx_id: txId, index, spent_output: spent });
const nanoHeader = (address: string) => ({
  id: '10', nc_seqnum: 1, nc_id: 'bb'.repeat(32), nc_method: 'initialize', nc_address: address,
});

// One owner, X, touching every kind of involvement. Shielded outputs are
// numbered after the transparent ones, so a vertex with no transparent outputs
// has its first shielded output at index 0.
const H1 = { n: 1, outputs: [transparentOut(1000n, X)] }; // transparent HTR receive
const H2 = { n: 2, shieldedOutputs: [fullyOut(2, X)] }; // T, reached only through FullyShielded
const H3 = { n: 3, tokens: [U], outputs: [transparentOut(50n, X, 1)] }; // U, transparent
const H4 = { n: 4, tokens: [U], shieldedOutputs: [amountOut(4, X, 1)] }; // U, then AmountShielded
const H5 = { n: 5, tokens: [V], shieldedOutputs: [amountOut(5, X, 1)] }; // V, AmountShielded only
const H6 = { n: 6, shieldedOutputs: [amountOut(6, X, 0)] }; // shielded-only HTR
const H7 = { // spends a transparent and a shielded output of X
  n: 7,
  inputs: [transparentIn(hash(1), 0, 1000n, X), shieldedIn(hash(6), 0, amountOut(6, X, 0))],
  outputs: [transparentOut(1000n, Y)],
};
const H8 = { n: 8, headers: [nanoHeader(X)] }; // nano call, no other involvement
const H9 = { n: 9, headers: [nanoHeader(X)], shieldedOutputs: [fullyOut(9, X)] }; // nano call with FullyShielded
const H10 = { n: 10, outputs: [transparentOut(77n, X)] }; // voided below
const H11 = { // X's output is parked (timelock wider than its column): no tx_output row
  n: 11, outputs: [transparentOut(5n, Y)], shieldedOutputs: [amountOut(11, X, 0, 2 ** 32 + 5)],
};
const H12 = { // spends the parked output, which has no row
  n: 12, inputs: [shieldedIn(hash(11), 1, amountOut(11, X, 0))], outputs: [transparentOut(5n, Y)],
};
const H13 = { // declares X's transparent U output shielded: excluded as an anomaly
  n: 13, inputs: [shieldedIn(hash(3), 0, amountOut(3, X, 1))], outputs: [transparentOut(1n, Y)],
};
const H14 = { n: 14, shieldedOutputs: [amountOut(14, X, 5)] }; // token_data resolves to no token
const H15 = { n: 15, headers: [nanoHeader(Z)] }; // nano caller with no other involvement

const FIXTURE = [H1, H2, H3, H4, H5, H6, H7, H8, H9, H10, H11, H12, H13, H14, H15];

type Recovery = 'none' | 'inline' | 'failing';

const prime = () => {
  const ep = Buffer.from(EPHEMERAL, 'hex');
  const c = (n: number) => Buffer.from(commitment(n), 'hex');
  const asset = Buffer.from('06'.repeat(33), 'hex');
  primeFullyRewind({ commitment: c(2), ephemeralPubkey: ep, value: 11n, tokenUid: Buffer.from(T, 'hex'), assetCommitment: asset });
  primeAmountRewind({ commitment: c(4), ephemeralPubkey: ep, value: 22n, tokenUid: Buffer.from(U, 'hex') });
  primeAmountRewind({ commitment: c(5), ephemeralPubkey: ep, value: 33n, tokenUid: Buffer.from(V, 'hex') });
  primeAmountRewind({ commitment: c(6), ephemeralPubkey: ep, value: 44n, tokenUid: Buffer.alloc(32) });
  primeFullyRewind({ commitment: c(9), ephemeralPubkey: ep, value: 55n, tokenUid: Buffer.from(T, 'hex'), assetCommitment: asset });
};

const reset = async () => {
  await cleanDatabase(mysql);
  await mysql.query('DELETE FROM shielded_tx_output_data');
  resetCtCryptoMock();
};

/**
 * Ingest the fixture. `none`: X belongs to no wallet, so its shielded outputs
 * stay unowned. `inline`: X is a claimed CTSpend address and every rewind
 * succeeds in line. `failing`: X is claimed but every rewind fails.
 */
const runFixture = async (recovery: Recovery) => {
  await reset();
  if (recovery !== 'none') {
    await mysql.query(
      `INSERT INTO address (address, wallet_id, \`index\`, bip32_account, scan_privkey, transactions)
       VALUES (?, ?, 0, 2, ?, 0)`,
      [X, WALLET, Buffer.alloc(32, 0x42)],
    );
  }
  if (recovery === 'inline') prime();
  for (const spec of FIXTURE) await ingest(spec);
  await voidVertex(H10);
};

const snapshot = async () => {
  const [history] = await mysql.query<any[]>(
    'SELECT * FROM `public_address_tx_history` ORDER BY `address`, `token_id`, `timestamp`, `tx_id`',
  );
  const [tokens] = await mysql.query<any[]>(
    'SELECT * FROM `public_address_tokens` ORDER BY `address`, `token_id`',
  );
  return { history, tokens };
};
const historyOf = async (address: string) => {
  const [rows] = await mysql.query<any[]>(
    `SELECT \`token_id\`, \`tx_id\`, \`timestamp\`, \`balance\`, \`has_shielded\`
       FROM \`public_address_tx_history\` WHERE \`address\` = ?
      ORDER BY \`token_id\`, \`timestamp\``,
    [address],
  );
  return rows.map((r) => ({ ...r, balance: BigInt(r.balance) }));
};
const tokensOf = async (address: string) => {
  const [rows] = await mysql.query<any[]>(
    `SELECT \`token_id\`, \`transactions\`, \`shielded_transactions\`, \`last_activity\`
       FROM \`public_address_tokens\` WHERE \`address\` = ? ORDER BY \`token_id\``,
    [address],
  );
  return rows;
};
const row = (tokenId: string, n: number, balance: bigint, hasShielded: boolean) => ({
  token_id: tokenId, tx_id: hash(n), timestamp: ts(n), balance, has_shielded: hasShielded ? 1 : 0,
});
const sortRows = <R extends { token_id: string; timestamp: number }>(rows: R[]) => [...rows].sort(
  (a, b) => (a.token_id === b.token_id ? a.timestamp - b.timestamp : a.token_id.localeCompare(b.token_id)),
);

beforeAll(async () => { mysql = await db.getDbConnection(); });
afterAll(async () => { await mysql.destroy(); });

describe('ingest', () => {
  beforeEach(reset);

  it('writes the public involvement of every vertex and counts it per token', async () => {
    for (const spec of FIXTURE) await ingest(spec);

    expect(await historyOf(X)).toEqual(sortRows([
      row('00', 1, 1000n, false),
      row('00', 6, 0n, true),
      row('00', 7, -1000n, true),
      row('00', 8, 0n, false),
      row('00', 10, 77n, false),
      row(U, 3, 50n, false),
      row(U, 4, 0n, true),
      row(V, 5, 0n, true),
      row(FULLY_SHIELDED_TOKEN_ID, 2, 0n, true),
      row(FULLY_SHIELDED_TOKEN_ID, 9, 0n, true),
      row(FULLY_SHIELDED_TOKEN_ID, 14, 0n, true),
    ]));
    expect(await tokensOf(X)).toEqual([
      { token_id: '00', transactions: 5, shielded_transactions: 2, last_activity: ts(10) },
      { token_id: U, transactions: 2, shielded_transactions: 1, last_activity: ts(4) },
      { token_id: V, transactions: 1, shielded_transactions: 1, last_activity: ts(5) },
      { token_id: FULLY_SHIELDED_TOKEN_ID, transactions: 3, shielded_transactions: 3, last_activity: ts(14) },
    ]);
    expect(await historyOf(Y)).toEqual([
      row('00', 7, 1000n, false),
      row('00', 11, 5n, false),
      row('00', 12, 5n, false),
      row('00', 13, 1n, false),
    ]);
    expect(await historyOf(Z)).toEqual([row('00', 15, 0n, false)]);
  });

  it('writes nothing for a parked output or an input spending a missing row', async () => {
    await ingest(H11);
    await ingest(H12);
    expect(await historyOf(X)).toEqual([]);
    expect(await tokensOf(X)).toEqual([]);
  });

  it('writes nothing for an anomalous shielded input', async () => {
    await ingest(H3);
    await ingest(H13);
    expect(await historyOf(X)).toEqual([row(U, 3, 50n, false)]);
  });
});

describe('void', () => {
  beforeEach(reset);

  it('removes the transaction\'s rows and recomputes the counters it touched', async () => {
    await ingest(H1);
    await ingest(H6);
    const before = await snapshot();
    await ingest(H10);

    expect(await tokensOf(X)).toEqual([
      { token_id: '00', transactions: 3, shielded_transactions: 1, last_activity: ts(10) },
    ]);
    await voidVertex(H10);
    // last_activity falls back to the newest remaining row, H6.
    expect(await snapshot()).toEqual(before);
    expect(await tokensOf(X)).toEqual([
      { token_id: '00', transactions: 2, shielded_transactions: 1, last_activity: ts(6) },
    ]);
  });

  it('takes a shielded row out of shielded_transactions', async () => {
    await ingest(H1);
    await ingest(H6);
    await voidVertex(H6);
    expect(await tokensOf(X)).toEqual([
      { token_id: '00', transactions: 1, shielded_transactions: 0, last_activity: ts(1) },
    ]);
  });

  it('deletes a pair whose last row is removed', async () => {
    await ingest(H1);
    await ingest(H5);
    await voidVertex(H5);
    expect(await tokensOf(X)).toEqual([
      { token_id: '00', transactions: 1, shielded_transactions: 0, last_activity: ts(1) },
    ]);
    expect(await historyOf(X)).toEqual([row('00', 1, 1000n, false)]);
  });

  it('is consistent again after the transaction is unvoided and ingested again', async () => {
    for (const spec of FIXTURE) await ingest(spec);
    const ingested = await snapshot();

    await voidVertex(H7);
    expect((await historyOf(Y)).map((r) => r.tx_id)).not.toContain(hash(7));
    await unvoidVertex(H7);
    await ingest(H7);

    expect(await snapshot()).toEqual(ingested);
  });

  it('removes the rows of a removed vertex', async () => {
    await ingest(H1);
    await ingest(H6);
    const before = await snapshot();
    await ingest(H10);

    await removeVertex(H10);
    expect(await snapshot()).toEqual(before);
  });

  describe('with counters that disagree with the rows', () => {
    let errorSpy: jest.SpyInstance;
    beforeEach(() => { errorSpy = jest.spyOn(logger, 'error'); });
    afterEach(() => { errorSpy.mockRestore(); });

    const errorsAbout = (text: string) => errorSpy.mock.calls.filter(([message]) => String(message).includes(text));

    it('clamps a counter at zero and logs it instead of failing', async () => {
      await ingest(H6);
      await ingest(H10);
      await mysql.query(
        "UPDATE `public_address_tokens` SET `transactions` = 0, `shielded_transactions` = 0 WHERE `address` = ? AND `token_id` = '00'",
        [X],
      );

      await voidVertex(H6);
      expect(errorsAbout('clamping')).toHaveLength(1);
      expect((await historyOf(X)).map((r) => r.tx_id)).toEqual([hash(10)]);
      expect(await tokensOf(X)).toEqual([]);
    });

    it('logs a missing counter row instead of failing', async () => {
      await ingest(H1);
      await ingest(H10);
      await mysql.query('DELETE FROM `public_address_tokens` WHERE `address` = ?', [X]);

      await voidVertex(H10);
      expect(errorsAbout('no public_address_tokens row')).toHaveLength(1);
      expect(await historyOf(X)).toEqual([row('00', 1, 1000n, false)]);
      expect(await tokensOf(X)).toEqual([]);
    });

    it('deletes a pair whose counter outlives its rows and logs it', async () => {
      await ingest(H10);
      await mysql.query(
        "UPDATE `public_address_tokens` SET `transactions` = 2 WHERE `address` = ? AND `token_id` = '00'",
        [X],
      );

      await voidVertex(H10);
      expect(errorsAbout('but no rows remain')).toHaveLength(1);
      expect(await historyOf(X)).toEqual([]);
      expect(await tokensOf(X)).toEqual([]);
    });
  });

  it('leaves the tables alone when cleaning up a transaction without rows', async () => {
    await ingest(H1);
    const before = await snapshot();
    await db.cleanupVoidedTx(mysql, hash(99));
    expect(await snapshot()).toEqual(before);
  });
});

describe('privacy', () => {
  it('writes identical tables whether shielded outputs stay unowned, are recovered, or fail to recover', async () => {
    await runFixture('none');
    const unowned = await snapshot();
    const [unownedHistory] = await mysql.query<any[]>('SELECT * FROM `address_tx_history` ORDER BY `address`, `token_id`, `tx_id`');

    await runFixture('inline');
    const recovered = await snapshot();
    const [recoveredStates] = await mysql.query<any[]>(
      'SELECT `recovery_state`, COUNT(*) AS `n` FROM `tx_output` WHERE `mode` <> 0 GROUP BY `recovery_state`',
    );
    const [recoveredHistory] = await mysql.query<any[]>('SELECT * FROM `address_tx_history` ORDER BY `address`, `token_id`, `tx_id`');

    await runFixture('failing');
    const failed = await snapshot();
    const [failedStates] = await mysql.query<any[]>(
      'SELECT `recovery_state`, COUNT(*) AS `n` FROM `tx_output` WHERE `mode` <> 0 GROUP BY `recovery_state`',
    );

    // The runs did diverge where recovery writes: the outputs were recovered
    // (H14's token does not resolve, so it fails in both claimed runs), and
    // address_tx_history shows it.
    expect(recoveredStates).toEqual(expect.arrayContaining([{ recovery_state: 'recovered', n: '5' }]));
    expect(failedStates).toEqual(expect.arrayContaining([{ recovery_state: 'recovery_failed', n: '6' }]));
    expect(recoveredHistory).not.toEqual(unownedHistory);

    expect(unowned.history.length).toBeGreaterThan(0);
    expect(recovered).toEqual(unowned);
    expect(failed).toEqual(unowned);
  });
});

describe('backfill', () => {
  it.each<Recovery>(['none', 'inline', 'failing'])('reproduces what ingest wrote (recovery: %s)', async (recovery) => {
    await runFixture(recovery);
    const ingested = await snapshot();

    await mysql.query('DELETE FROM `public_address_tx_history`');
    await mysql.query('DELETE FROM `public_address_tokens`');
    const report = await runSqlScript(mysql, BACKFILL_PUBLIC_ADDRESS_TABLES_SQL, { batch_size: 2 }) as any[];

    expect(await snapshot()).toEqual(ingested);
    // H8 and H15; H9's caller has a FullyShielded row, so it is not one.
    expect(Number(report[0].nano_caller_rows)).toBe(2);
  });

  it('removes rows the rule does not produce', async () => {
    await runFixture('none');
    const ingested = await snapshot();

    await mysql.query(
      `INSERT INTO \`public_address_tx_history\` (\`address\`, \`token_id\`, \`timestamp\`, \`tx_id\`, \`balance\`, \`has_shielded\`)
       VALUES (?, ?, ?, ?, 7, FALSE)`,
      [X, T, ts(1), hash(1)],
    );
    await mysql.query(
      `INSERT INTO \`public_address_tokens\` (\`address\`, \`token_id\`, \`transactions\`, \`shielded_transactions\`, \`last_activity\`)
       VALUES (?, ?, 1, 0, ?)`,
      [X, T, ts(1)],
    );
    await runSqlScript(mysql, BACKFILL_PUBLIC_ADDRESS_TABLES_SQL, { batch_size: 2 });
    expect(await snapshot()).toEqual(ingested);
  });

  it('counts a transparent row with NULL authorities as no authority', async () => {
    await runFixture('none');
    const ingested = await snapshot();

    await mysql.query('UPDATE `tx_output` SET `authorities` = NULL WHERE `mode` = 0 AND `authorities` = 0');
    await mysql.query('DELETE FROM `public_address_tx_history`');
    await mysql.query('DELETE FROM `public_address_tokens`');
    await runSqlScript(mysql, BACKFILL_PUBLIC_ADDRESS_TABLES_SQL, { batch_size: 2 });
    expect(await snapshot()).toEqual(ingested);
  });

  it('rejects a batch size below one without writing', async () => {
    await runFixture('none');
    const ingested = await snapshot();

    await expect(runSqlScript(mysql, BACKFILL_PUBLIC_ADDRESS_TABLES_SQL, { batch_size: 0 }))
      .rejects.toThrow('@batch_size must be a positive integer');
    expect(await snapshot()).toEqual(ingested);
  });

  it('is idempotent and resumable', async () => {
    await runFixture('none');
    const ingested = await snapshot();

    await runSqlScript(mysql, BACKFILL_PUBLIC_ADDRESS_TABLES_SQL, { batch_size: 1 });
    expect(await snapshot()).toEqual(ingested);

    await mysql.query('DELETE FROM `public_address_tx_history` WHERE `address` > ?', [X]);
    await mysql.query('DELETE FROM `public_address_tokens` WHERE `address` > ?', [X]);
    await runSqlScript(mysql, BACKFILL_PUBLIC_ADDRESS_TABLES_SQL, { resume_after: X });
    expect(await snapshot()).toEqual(ingested);
  });
});

describe('transparent-only data', () => {
  beforeEach(reset);

  it('matches address_tx_history row for row', async () => {
    const MINT = 0b01;
    const vertices = [
      H1,
      H3,
      { n: 20, tokens: [U], outputs: [transparentOut(BigInt(MINT), X, 0x81), transparentOut(5n, Y, 1)] },
      { n: 21, tokens: [U], inputs: [transparentIn(hash(20), 0, BigInt(MINT), X, 0x81)], outputs: [transparentOut(1n, Z)] },
      { n: 22, inputs: [transparentIn(hash(1), 0, 1000n, X)], outputs: [transparentOut(600n, Y), transparentOut(400n, X)] },
      H8,
      H10,
    ];
    for (const spec of vertices) await ingest(spec);
    await voidVertex(H10);

    const [publicRows] = await mysql.query<any[]>(
      `SELECT \`address\`, \`token_id\`, \`tx_id\`, \`timestamp\`, \`balance\`
         FROM \`public_address_tx_history\` ORDER BY \`address\`, \`token_id\`, \`tx_id\``,
    );
    const [historyRows] = await mysql.query<any[]>(
      `SELECT \`address\`, \`token_id\`, \`tx_id\`, \`timestamp\`, \`balance\`
         FROM \`address_tx_history\` ORDER BY \`address\`, \`token_id\`, \`tx_id\``,
    );
    expect(publicRows.length).toBe(historyRows.length);
    expect(publicRows).toEqual(historyRows);
  });
});
