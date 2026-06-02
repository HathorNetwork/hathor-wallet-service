/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Tests for `token.total_supply` tracking in `handleVertexAccepted` and
 * `handleTokenCreated`.
 *
 * Coverage:
 *  - Token creation sets total_supply to the SUM of non-authority transparent
 *    outputs in the creation tx (path 1).
 *  - Block reward increases HTR total_supply on every block (path 2).
 *  - Mint, melt, and burn-address outputs apply a signed delta via
 *    `sum(outputs except burn) - sum(inputs)` (path 3).
 *  - The shielded gate suppresses path 3 when the vertex carries any shielded
 *    output, leaving total_supply unchanged.
 */

import * as db from '../../src/db';
import {
  handleTokenCreated,
  handleVertexAccepted,
  handleVoidedTx,
  handleUnvoidedTx,
  handleVertexRemoved,
} from '../../src/services';
import { LRU } from '../../src/utils';
import { cleanDatabase } from '../utils';
import { Connection } from 'mysql2/promise';
import hathorLib from '@hathor/wallet-lib';

/**
 * @jest-environment node
 */

// Use a single mysql connection across tests.
let mysql: Connection;

beforeAll(async () => {
  try {
    mysql = await db.getDbConnection();
  } catch (e) {
    console.error('Failed to establish db connection', e);
    throw e;
  }
});

afterAll(async () => {
  if (mysql) {
    await mysql.destroy();
  }
});

beforeEach(async () => {
  await cleanDatabase(mysql);
});

const HTR_TOKEN_ID = hathorLib.constants.NATIVE_TOKEN_UID;
const AUTHORITY_BIT = hathorLib.constants.TOKEN_AUTHORITY_MASK;
const BURN_ADDRESS = 'HDeadDeadDeadDeadDeadDeadDeagTPgmn';

// Fixed P2PKH script and decoded shape — value/address-only tests don't care
// about the script bytes. Use a benign placeholder.
const SCRIPT_B64 = 'dqkU91U6sMdzgT3zxOtdIVGbqobP0FmIrA==';

const seedToken = async (tokenId: string, totalSupply: bigint): Promise<void> => {
  await mysql.query(
    `INSERT INTO token (id, name, symbol, total_supply) VALUES (?, ?, ?, ?)`,
    [tokenId, `name-${tokenId}`, `S${tokenId.slice(0, 3)}`, totalSupply.toString()],
  );
};

const selectTotalSupply = async (tokenId: string): Promise<bigint> => {
  const [rows] = await mysql.query<any[]>(
    `SELECT total_supply FROM token WHERE id = ?`,
    [tokenId],
  );
  if (rows.length === 0) throw new Error(`Token ${tokenId} not seeded`);
  return BigInt(rows[0].total_supply);
};

// Build a NEW_VERTEX_ACCEPTED context. The shape matches what
// `handleVertexAccepted` reads from `context.event.event.data` plus the
// scaffolding fields it touches on `context` itself.
const buildVertexContext = (data: any) => ({
  socket: undefined,
  healthcheck: undefined,
  retryAttempt: 0,
  initialEventId: null,
  txCache: new LRU(100),
  rewardMinBlocks: 300,
  event: {
    stream_id: 'stream-id',
    peer_id: 'peer-id',
    network: 'mainnet',
    type: 'FULLNODE_EVENT',
    latest_event_id: 1,
    event: {
      id: 1,
      timestamp: 1700000000,
      type: 'NEW_VERTEX_ACCEPTED',
      data,
    },
  },
});

// Compose a transparent (mode=0) tx_output event entry — value-bearing or
// authority depending on `tokenData`. The decoded address resolves correctly
// for both transparent and burn-bound outputs.
const transparentOutput = (
  value: number | bigint,
  tokenData: number,
  address: string,
) => ({
  value,
  script: SCRIPT_B64,
  token_data: tokenData,
  decoded: {
    type: 'P2PKH',
    address,
    timelock: null,
  },
});

// Compose a tx_input pointing at a value-bearing spent output. The daemon
// reads `spent_output.value` and `spent_output.token_data` only.
const transparentInput = (
  parentTxId: string,
  index: number,
  value: number | bigint,
  tokenData: number,
  address: string,
) => ({
  tx_id: parentTxId,
  index,
  spent_output: {
    mode: 0,
    value,
    script: SCRIPT_B64,
    token_data: tokenData,
    decoded: {
      type: 'P2PKH',
      address,
      timelock: null,
    },
  },
});

// Minimal data block matching `TxEventDataSchema`. Fields not asserted by the
// supply-update path may be defaulted.
const buildVertexData = (overrides: Partial<{
  hash: string;
  outputs: any[];
  inputs: any[];
  tokens: string[];
  shielded_outputs: any[];
  version: number;
  height: number | null;
  first_block: string | null;
}> = {}) => ({
  hash: overrides.hash ?? 'a'.repeat(64),
  nonce: 0,
  timestamp: 1700000000,
  version: overrides.version ?? 1,
  weight: 1,
  signal_bits: 0,
  inputs: overrides.inputs ?? [],
  outputs: overrides.outputs ?? [],
  shielded_outputs: overrides.shielded_outputs ?? [],
  parents: [],
  tokens: overrides.tokens ?? [],
  token_name: null,
  token_symbol: null,
  metadata: {
    hash: overrides.hash ?? 'a'.repeat(64),
    voided_by: [],
    first_block: overrides.first_block ?? null,
    height: overrides.height ?? 100,
  },
  aux_pow: null,
});

describe('token.total_supply tracking', () => {
  it('token creation sets total_supply from wire initial_amount', async () => {
    expect.hasAssertions();

    // Regular CREATE_TOKEN_TX: token_uid === tx_id by convention.
    const tokenId = 'token-creation-001';
    const txId = tokenId;

    // The transparent outputs here are not consulted: handleTokenCreated
    // now reads `initial_amount` from the wire payload directly. Their
    // sum (1000) intentionally differs from `initial_amount` (12345) to
    // prove the wire value wins.
    await db.addOrUpdateTx(mysql, txId, null, 1700000000, 1, 1, null);
    await mysql.query(
      `INSERT INTO tx_output (tx_id, \`index\`, token_id, address, value, authorities, locked, voided, mode)
       VALUES
         (?, 0, ?, 'addr-mint-a', 600, 0, 0, 0, 0),
         (?, 1, ?, 'addr-mint-b', 400, 0, 0, 0, 0),
         (?, 2, ?, 'addr-auth',   0,   1, 0, 0, 0)`,
      [txId, tokenId, txId, tokenId, txId, tokenId],
    );


    const context = {
      socket: undefined,
      healthcheck: undefined,
      retryAttempt: 0,
      initialEventId: null,
      txCache: new LRU(100),
      event: {
        stream_id: 'stream-id',
        peer_id: 'peer-id',
        network: 'mainnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: 1,
        event: {
          id: 1,
          timestamp: 1700000000,
          type: 'TOKEN_CREATED',
          data: {
            token_uid: tokenId,
            nc_exec_info: null,
            token_name: 'CreationToken',
            token_symbol: 'CRT',
            token_version: 1,
            initial_amount: 12345,
          },
          group_id: null,
        },
      },
    };

    await handleTokenCreated(context as any);

    expect(await selectTotalSupply(tokenId)).toStrictEqual(12345n);
  });

  it('token creation falls back to 0 when initial_amount is absent on the wire', async () => {
    expect.hasAssertions();

    const tokenId = 'token-creation-no-amount';
    const txId = tokenId;

    // Seed a creation tx with outputs that, under the old SUM-based
    // logic, would have produced a non-zero supply. Under the new logic
    // an absent `initial_amount` should produce total_supply = 0.
    await db.addOrUpdateTx(mysql, txId, null, 1700000000, 1, 1, null);
    await mysql.query(
      `INSERT INTO tx_output (tx_id, \`index\`, token_id, address, value, authorities, locked, voided, mode)
       VALUES (?, 0, ?, 'addr-x', 999, 0, 0, 0, 0)`,
      [txId, tokenId],
    );

    const context = {
      socket: undefined,
      healthcheck: undefined,
      retryAttempt: 0,
      initialEventId: null,
      txCache: new LRU(100),
      event: {
        stream_id: 'stream-id',
        peer_id: 'peer-id',
        network: 'mainnet',
        type: 'FULLNODE_EVENT',
        latest_event_id: 1,
        event: {
          id: 1,
          timestamp: 1700000000,
          type: 'TOKEN_CREATED',
          data: {
            token_uid: tokenId,
            nc_exec_info: null,
            token_name: 'NoAmount',
            token_symbol: 'NA',
            token_version: 1,
          },
          group_id: null,
        },
      },
    };

    await handleTokenCreated(context as any);

    expect(await selectTotalSupply(tokenId)).toStrictEqual(0n);
  });

  it('mint tx increments total_supply by the minted delta', async () => {
    expect.hasAssertions();

    const tokenId = 'token-mint-001';
    await seedToken(tokenId, 1000n);

    // Inputs: one melt authority (no value). Outputs: 500 value at tokens[0],
    // plus a fresh mint authority. Mint delta = 500 - 0 = +500.
    const data = buildVertexData({
      hash: 'b'.repeat(64),
      tokens: [tokenId],
      inputs: [transparentInput('parent-tx', 0, 1n, AUTHORITY_BIT | 1, 'addr-prev-auth')],
      outputs: [
        transparentOutput(500, 1, 'addr-recipient'),
        transparentOutput(1, AUTHORITY_BIT | 1, 'addr-new-auth'),
      ],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);

    expect(await selectTotalSupply(tokenId)).toStrictEqual(1500n);
  });

  it('melt tx decreases total_supply by the melted delta', async () => {
    expect.hasAssertions();

    const tokenId = 'token-melt-001';
    await seedToken(tokenId, 1000n);

    // Inputs: 800 value-bearing. Outputs: 500 to a recipient (no burn, no
    // mint). Net delta = 500 - 800 = -300.
    const data = buildVertexData({
      hash: 'c'.repeat(64),
      tokens: [tokenId],
      inputs: [transparentInput('parent-tx', 0, 800n, 1, 'addr-prev-holder')],
      outputs: [transparentOutput(500, 1, 'addr-recipient')],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);

    expect(await selectTotalSupply(tokenId)).toStrictEqual(700n);
  });

  it('transparent output to BURN_ADDRESS decreases total_supply', async () => {
    expect.hasAssertions();

    const tokenId = 'token-burn-001';
    await seedToken(tokenId, 1000n);

    // Inputs: 100 value-bearing. Outputs: 60 to a recipient + 40 to burn.
    // Net delta = 60 (recipient) - 100 (input) = -40 — the burn appears
    // naturally as the missing-from-outputs leg.
    const data = buildVertexData({
      hash: 'd'.repeat(64),
      tokens: [tokenId],
      inputs: [transparentInput('parent-tx', 0, 100n, 1, 'addr-source')],
      outputs: [
        transparentOutput(60, 1, 'addr-recipient'),
        transparentOutput(40, 1, BURN_ADDRESS),
      ],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);

    expect(await selectTotalSupply(tokenId)).toStrictEqual(960n);
  });

  it('mint+burn in the same tx applies the net delta', async () => {
    expect.hasAssertions();

    const tokenId = 'token-mix-001';
    await seedToken(tokenId, 50n);

    // Plan example: inputs = 50, outputs = 70 alice + 30 BURN + 50 bob, mint
    // authority output present. With burn-exclusion folded into path 3:
    //   delta = (70 + 50) - 50 = +70.
    const data = buildVertexData({
      hash: 'e'.repeat(64),
      tokens: [tokenId],
      inputs: [
        transparentInput('parent-tx', 0, 50n, 1, 'addr-prev-holder'),
        transparentInput('parent-tx', 1, 1n, AUTHORITY_BIT | 1, 'addr-prev-auth'),
      ],
      outputs: [
        transparentOutput(70, 1, 'addr-alice'),
        transparentOutput(30, 1, BURN_ADDRESS),
        transparentOutput(50, 1, 'addr-bob'),
        transparentOutput(1, AUTHORITY_BIT | 1, 'addr-new-auth'),
      ],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);

    expect(await selectTotalSupply(tokenId)).toStrictEqual(120n);
  });

  it('mint tx with any shielded output leaves total_supply unchanged (gate fires)', async () => {
    expect.hasAssertions();

    const tokenId = 'token-gate-001';
    await seedToken(tokenId, 1000n);

    // Same shape as the mint case, but with a shielded output present. The
    // path-3 gate must suppress the supply update.
    const data = buildVertexData({
      hash: 'f'.repeat(64),
      tokens: [tokenId],
      inputs: [transparentInput('parent-tx', 0, 1n, AUTHORITY_BIT | 1, 'addr-prev-auth')],
      outputs: [
        transparentOutput(500, 1, 'addr-recipient'),
        transparentOutput(1, AUTHORITY_BIT | 1, 'addr-new-auth'),
      ],
      shielded_outputs: [{
        mode: 1,
        commitment: '02'.repeat(33),
        range_proof: '03'.repeat(64),
        script: '04'.repeat(20),
        ephemeral_pubkey: '05'.repeat(33),
        token_data: 0,
        decoded: { address: 'WShieldedAddrGate1' },
      }],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);

    expect(await selectTotalSupply(tokenId)).toStrictEqual(1000n);
  });

  it('block accepted adds the block reward to HTR total_supply', async () => {
    expect.hasAssertions();

    await seedToken(HTR_TOKEN_ID, 1_000_000n);

    // Version 0 is BLOCK_VERSION. The first output's value is the coinbase.
    const data = buildVertexData({
      hash: '1'.repeat(64),
      version: hathorLib.constants.BLOCK_VERSION,
      tokens: [],
      inputs: [],
      outputs: [transparentOutput(6400, 0, 'addr-miner')],
      height: 100,
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);

    expect(await selectTotalSupply(HTR_TOKEN_ID)).toStrictEqual(1_006_400n);
  });

  it('applyTokenSupplyUpdates on CREATE_TOKEN_TX does not write the new token row', async () => {
    expect.hasAssertions();

    // CREATE_TOKEN_TX vertex: the freshly-minted token row does NOT exist
    // yet — handleTokenCreated is what inserts it later via a separate
    // TOKEN_CREATED event. The per-token supply-delta loop in
    // handleVertexAccepted runs first against the same vertex and would
    // historically have tried to insert the token row from a positive
    // delta; with the UPDATE-only contract, that write must no-op.
    const tokenId = 'token-create-vertex-001';
    const txId = 'd'.repeat(64);

    const data = buildVertexData({
      hash: txId,
      version: hathorLib.constants.CREATE_TOKEN_TX_VERSION,
      tokens: [tokenId],
      // No inputs (pretending the deposit was zero for simplicity). The
      // single output for the new token would produce a per-token delta
      // of +500, which incrementTokenTotalSupply must not turn into an
      // INSERT against `token`.
      inputs: [],
      outputs: [transparentOutput(500, 1, 'addr-mint-recipient')],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);

    const [rows] = await mysql.query<any[]>(
      `SELECT total_supply FROM token WHERE id = ?`,
      [tokenId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('token.total_supply reversal on void / unvoid / remove', () => {
  // The void / remove handlers carry no wire event of their own — they read
  // the to-be-reversed vertex back out of the DB. Build the context shape they
  // consume from the same `data` block the accept path used.
  const buildReverseContext = (data: any) => ({
    socket: undefined,
    healthcheck: undefined,
    retryAttempt: 0,
    initialEventId: null,
    txCache: new LRU(100),
    rewardMinBlocks: 300,
    event: {
      stream_id: 'stream-id',
      peer_id: 'peer-id',
      network: 'mainnet',
      type: 'FULLNODE_EVENT',
      latest_event_id: 2,
      event: {
        id: 2,
        data: {
          hash: data.hash,
          outputs: data.outputs,
          inputs: data.inputs,
          tokens: data.tokens,
          version: data.version,
          headers: [],
        },
      },
    },
  });

  // The shielded satellite is not part of the shared cleanDatabase table set.
  beforeEach(async () => {
    await mysql.query('DELETE FROM shielded_tx_output_data');
  });
  afterEach(async () => {
    await mysql.query('DELETE FROM shielded_tx_output_data');
  });

  it('reverses the block reward when a block vertex is voided', async () => {
    expect.hasAssertions();
    await seedToken(HTR_TOKEN_ID, 1_000_000n);

    const data = buildVertexData({
      hash: '1'.repeat(64),
      version: hathorLib.constants.BLOCK_VERSION,
      tokens: [],
      inputs: [],
      outputs: [transparentOutput(6400, 0, 'addr-miner')],
      height: 100,
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);
    expect(await selectTotalSupply(HTR_TOKEN_ID)).toStrictEqual(1_006_400n);

    await handleVoidedTx(buildReverseContext(data) as any);
    expect(await selectTotalSupply(HTR_TOKEN_ID)).toStrictEqual(1_000_000n);
  });

  it('reverses the mint delta when a mint vertex is voided', async () => {
    expect.hasAssertions();
    const tokenId = 'token-mint-void';
    await seedToken(tokenId, 1000n);

    const data = buildVertexData({
      hash: 'b'.repeat(64),
      tokens: [tokenId],
      inputs: [transparentInput('parent-tx', 0, 1n, AUTHORITY_BIT | 1, 'addr-prev-auth')],
      outputs: [
        transparentOutput(500, 1, 'addr-recipient'),
        transparentOutput(1, AUTHORITY_BIT | 1, 'addr-new-auth'),
      ],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);
    expect(await selectTotalSupply(tokenId)).toStrictEqual(1500n);

    await handleVoidedTx(buildReverseContext(data) as any);
    expect(await selectTotalSupply(tokenId)).toStrictEqual(1000n);
  });

  it('reverses a burn (re-credits supply) when a burn vertex is voided', async () => {
    expect.hasAssertions();
    const tokenId = 'token-burn-void';
    await seedToken(tokenId, 1000n);

    const data = buildVertexData({
      hash: 'c'.repeat(64),
      tokens: [tokenId],
      inputs: [transparentInput('parent-tx', 0, 100n, 1, 'addr-source')],
      outputs: [
        transparentOutput(60, 1, 'addr-recipient'),
        transparentOutput(40, 1, BURN_ADDRESS),
      ],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);
    expect(await selectTotalSupply(tokenId)).toStrictEqual(960n);

    await handleVoidedTx(buildReverseContext(data) as any);
    expect(await selectTotalSupply(tokenId)).toStrictEqual(1000n);
  });

  it('round-trips: ingest -> void -> unvoid restores total_supply', async () => {
    expect.hasAssertions();
    const tokenId = 'token-mint-roundtrip';
    await seedToken(tokenId, 1000n);

    const data = buildVertexData({
      hash: '9'.repeat(64),
      tokens: [tokenId],
      inputs: [transparentInput('parent-tx', 0, 1n, AUTHORITY_BIT | 1, 'addr-prev-auth')],
      outputs: [
        transparentOutput(500, 1, 'addr-recipient'),
        transparentOutput(1, AUTHORITY_BIT | 1, 'addr-new-auth'),
      ],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);
    expect(await selectTotalSupply(tokenId)).toStrictEqual(1500n);

    await handleVoidedTx(buildReverseContext(data) as any);
    expect(await selectTotalSupply(tokenId)).toStrictEqual(1000n);

    // Unvoid = cleanupVoidedTx (delete the voided rows) followed by the state
    // machine's re-ingest. Mirror that here: the re-ingest re-applies the
    // forward supply delta, restoring the post-ingest state.
    await handleUnvoidedTx(buildReverseContext(data) as any);
    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);
    expect(await selectTotalSupply(tokenId)).toStrictEqual(1500n);
  });

  it('leaves total_supply untouched when voiding a vertex with shielded outputs', async () => {
    expect.hasAssertions();
    const tokenId = 'token-gate-void';
    await seedToken(tokenId, 1000n);

    // A mint-shaped vertex that also carries a shielded output: the path-3 gate
    // suppressed the supply update on ingest, so the void reversal must be
    // gated identically and leave total_supply at its seeded value.
    const data = buildVertexData({
      hash: 'f'.repeat(64),
      tokens: [tokenId],
      inputs: [transparentInput('parent-tx', 0, 1n, AUTHORITY_BIT | 1, 'addr-prev-auth')],
      outputs: [
        transparentOutput(500, 1, 'addr-recipient'),
        transparentOutput(1, AUTHORITY_BIT | 1, 'addr-new-auth'),
      ],
      shielded_outputs: [{
        mode: 1,
        commitment: '02'.repeat(33),
        range_proof: '03'.repeat(64),
        script: '04'.repeat(20),
        ephemeral_pubkey: '05'.repeat(33),
        token_data: 0,
        decoded: { address: 'WShieldedAddrGateVoid' },
      }],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);
    expect(await selectTotalSupply(tokenId)).toStrictEqual(1000n);

    await handleVoidedTx(buildReverseContext(data) as any);
    expect(await selectTotalSupply(tokenId)).toStrictEqual(1000n);
  });

  it('reverses the mint delta when a mint vertex is removed (reorg)', async () => {
    expect.hasAssertions();
    const tokenId = 'token-mint-remove';
    await seedToken(tokenId, 1000n);

    const data = buildVertexData({
      hash: '7'.repeat(64),
      tokens: [tokenId],
      inputs: [transparentInput('parent-tx', 0, 1n, AUTHORITY_BIT | 1, 'addr-prev-auth')],
      outputs: [
        transparentOutput(500, 1, 'addr-recipient'),
        transparentOutput(1, AUTHORITY_BIT | 1, 'addr-new-auth'),
      ],
    });

    await handleVertexAccepted(buildVertexContext(data) as any, undefined as any);
    expect(await selectTotalSupply(tokenId)).toStrictEqual(1500n);

    await handleVertexRemoved(buildReverseContext(data) as any, undefined as any);
    // The token pre-existed this vertex, so it is not deleted — only the mint
    // delta is reversed.
    expect(await selectTotalSupply(tokenId)).toStrictEqual(1000n);
  });
});
