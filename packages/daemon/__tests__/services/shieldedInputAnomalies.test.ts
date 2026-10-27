// Anomalous shielded inputs: a wire-shielded input whose stored row is transparent.
const mockAddAlert = jest.fn();
jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: mockAddAlert,
}));

import { Connection } from 'mysql2/promise';
import * as db from '../../src/db';
import { handleVertexAccepted } from '../../src/services';
import { LRU } from '../../src/utils';
import { cleanDatabase, XPUBKEY } from '../utils';

const ANOMALY_ALERT = 'Shielded input resolved to a non-shielded output';
const WALLET = 'w1';
const ADDR_A = 'WAnomalyTransparentA';
const ADDR_B = 'WAnomalyTransparentB';
const SHIELDED_ADDR = 'WAnomalyShieldedAddr';
const EXTERNAL = 'WAnomalyExternalAddr';
const SCRIPT = 'dqkU91U6sMdzgT3zxOtdIVGbqobP0FmIrA==';
const F = 'fa'.repeat(32);
const S = 'ab'.repeat(32);
const PARENTS = [
  '16ba3dbe424c443e571b00840ca54b9ff4cff467e10b6a15536e718e2008f952',
  '33e14cb555a96967841dcbe0f95e9eab5810481d01de8f4f73afb8cce365e869',
];

let mysql: Connection;
let eventId = 9000;

const vertex = (hash: string, inputs: unknown[], outputs: unknown[], shieldedOutputs: unknown[]) => {
  eventId += 1;
  return {
    type: 'EVENT',
    latest_event_id: eventId + 1,
    event: {
      stream_id: 'test', network: 'mainnet', peer_id: 'test', id: eventId, timestamp: 1700000000,
      type: 'NEW_VERTEX_ACCEPTED', group_id: null,
      data: {
        hash, nonce: 1, timestamp: 1700000000, version: 1, weight: 21.5, signal_bits: 0,
        inputs, outputs, shielded_outputs: shieldedOutputs, parents: PARENTS, tokens: [],
        token_name: null, token_symbol: null, aux_pow: null,
        metadata: { hash, voided_by: [], first_block: null, height: 100 },
      },
    },
  };
};
const transparentOut = (value: bigint, address: string, timelock: number | null = null) => ({
  value, script: SCRIPT, token_data: 0, decoded: { type: 'P2PKH', address, timelock },
});
const shieldedFields = (address: string) => ({
  mode: 1,
  commitment: '02'.repeat(33),
  range_proof: '03'.repeat(64),
  script: '04'.repeat(20),
  ephemeral_pubkey: '05'.repeat(33),
  token_data: 0,
  decoded: { address },
});
// An input the wire declares AmountShielded, pointing at (txId, index).
const shieldedIn = (txId: string, index: number) => ({
  tx_id: txId, index, spent_output: shieldedFields(SHIELDED_ADDR),
});
const ingest = (event: unknown) => handleVertexAccepted({
  socket: {}, healthcheck: {}, retryAttempt: 0, initialEventId: null,
  txCache: new LRU(100), rewardMinBlocks: 300, event,
} as any, undefined as any);

const outputRow = async (txId: string, index: number) => {
  const [rows] = await mysql.query<any[]>(
    'SELECT `locked`, `spent_by` FROM `tx_output` WHERE `tx_id` = ? AND `index` = ?', [txId, index],
  );
  return rows[0];
};
const balances = async () => {
  const [address] = await mysql.query<any[]>(
    'SELECT `unlocked_balance`, `locked_balance` FROM `address_balance` WHERE `address` = ? AND `token_id` = ?',
    [ADDR_A, '00'],
  );
  const [wallet] = await mysql.query<any[]>(
    'SELECT `unlocked_balance`, `locked_balance` FROM `wallet_balance` WHERE `wallet_id` = ? AND `token_id` = ?',
    [WALLET, '00'],
  );
  return { address: address[0], wallet: wallet[0] };
};
const anomalyAlerts = () => mockAddAlert.mock.calls.filter(([title]) => title === ANOMALY_ALERT);

beforeAll(async () => { mysql = await db.getDbConnection(); });
afterAll(async () => { await mysql.destroy(); });
beforeEach(async () => {
  await cleanDatabase(mysql);
  await mysql.query('DELETE FROM shielded_tx_output_data');
  mockAddAlert.mockClear();
  const now = Math.floor(Date.now() / 1000);
  await mysql.query(
    `INSERT INTO wallet (id, xpubkey, auth_xpubkey, status, max_gap, created_at, ready_at, ct_status)
     VALUES (?, ?, ?, 'ready', 20, ?, ?, 'none')`,
    [WALLET, XPUBKEY, XPUBKEY, now, now],
  );
  // Index 20 keeps the gap filled so no xpub derivation runs.
  await mysql.query(
    `INSERT INTO address (address, \`index\`, wallet_id, transactions, bip32_account)
     VALUES (?, 0, ?, 0, 0), (?, 1, ?, 0, 0), ('WAnomalyTransparent20', 20, ?, 0, 0)`,
    [ADDR_A, WALLET, ADDR_B, WALLET, WALLET],
  );
});

it('leaves a locked transparent UTXO locked when an anomalous shielded input points at it', async () => {
  // F: a transparent output timelocked in the future (F:0) and a shielded output (F:1).
  const future = Math.floor(Date.now() / 1000) + 100_000_000;
  await ingest(vertex(F, [], [transparentOut(1000n, ADDR_A, future)], [shieldedFields(SHIELDED_ADDR)]));
  expect(await outputRow(F, 0)).toMatchObject({ locked: 1, spent_by: null });
  const before = await balances();

  // S declares (F, 0) shielded on the wire, but F:0 is stored as transparent.
  mockAddAlert.mockClear();
  await ingest(vertex(S, [shieldedIn(F, 0)], [transparentOut(1000n, EXTERNAL)], []));

  // Excluded before the unlock: still locked, unspent, and no value moved.
  expect(await outputRow(F, 0)).toMatchObject({ locked: 1, spent_by: null });
  expect(await balances()).toEqual(before);
  expect(anomalyAlerts()).toHaveLength(1);
});

it('reports two anomalous inputs of one vertex in a single alert', async () => {
  // F: two transparent outputs (0, 1) and two shielded outputs (2, 3).
  await ingest(vertex(
    F, [],
    [transparentOut(1000n, ADDR_A), transparentOut(700n, ADDR_B)],
    [shieldedFields(SHIELDED_ADDR), shieldedFields(SHIELDED_ADDR)],
  ));

  mockAddAlert.mockClear();
  await ingest(vertex(S, [shieldedIn(F, 0), shieldedIn(F, 1)], [transparentOut(1700n, EXTERNAL)], []));

  const alerts = anomalyAlerts();
  expect(alerts).toHaveLength(1);
  expect(alerts[0][3]).toMatchObject({ tx_id: S, count: 2 });
  expect(alerts[0][3].inputs).toHaveLength(2);
  expect((await outputRow(F, 0)).spent_by).toBeNull();
  expect((await outputRow(F, 1)).spent_by).toBeNull();
});
