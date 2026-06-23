/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Owned-wallet ingest triggers wallet-lib's gap-fill/address-derivation path,
// which is slow against a real xpubkey; bump the timeout to match the other
// DB-backed shielded suites.
jest.setTimeout(30000);

jest.mock('../../src/crypto/ctRewind', () => require('../mocks/ct-crypto-node').mockCtCrypto);

const mockAddAlert = jest.fn();
jest.mock('@wallet-service/common', () => {
  const actual = jest.requireActual('@wallet-service/common');
  return { ...actual, addAlert: mockAddAlert };
});

// Partial-mock the aws module so the outbound SQS / lambda calls are stubbed
// while every other util (used heavily by handleVertexAccepted) stays real.
jest.mock('../../src/utils/aws', () => {
  const actual = jest.requireActual('../../src/utils/aws');
  return {
    ...actual,
    sendRealtimeTx: jest.fn(),
    invokeOnTxPushNotificationRequestedLambda: jest.fn(),
  };
});

import * as db from '../../src/db';
import { handleVertexAccepted } from '../../src/services';
import { LRU, getWalletBalancesForTx, sortBalanceValueByAbsTotal } from '../../src/utils';
import { sendRealtimeTx } from '../../src/utils/aws';
import { cleanDatabase, XPUBKEY } from '../utils';
import { TokenBalanceMap } from '@wallet-service/common';
import { Connection } from 'mysql2/promise';
import eventsFixture from '../__fixtures__/events';

/**
 * @jest-environment node
 */

let mysql: Connection;

beforeAll(async () => {
  mysql = await db.getDbConnection();
});

afterAll(async () => {
  if (mysql) await mysql.destroy();
});

beforeEach(async () => {
  await cleanDatabase(mysql);
  await mysql.query('DELETE FROM shielded_tx_output_data');
  jest.clearAllMocks();
});

afterEach(async () => {
  await mysql.query('DELETE FROM shielded_tx_output_data');
});

describe('handleVertexAccepted realtime new-tx payload', () => {
  it('enqueues the involved addresses and a lightweight shielded_outputs projection', async () => {
    expect.hasAssertions();

    // VERTEX_WITH_SHIELDED carries a transparent output to WTransparentAddress1
    // and a shielded output to WShieldedAddress1. Own the transparent address
    // so the wallet is "seen" and sendRealtimeTx fires; the shielded output
    // stays unowned (no rewind needed) but its address still rides in the
    // involved-address set.
    const now = Math.floor(Date.now() / 1000);
    await mysql.query(
      `INSERT INTO \`wallet\` (id, xpubkey, auth_xpubkey, status, max_gap, created_at, ready_at)
       VALUES ('wallet_alice', ?, ?, 'ready', 20, ?, ?)`,
      [XPUBKEY, XPUBKEY, now, now],
    );
    await mysql.query(
      `INSERT INTO address (address, wallet_id, \`index\`, bip32_account, transactions)
       VALUES ('WTransparentAddress1', 'wallet_alice', 0, 0, 0)`,
    );

    const fixture = JSON.parse(JSON.stringify(eventsFixture.VERTEX_WITH_SHIELDED));
    const context = {
      socket: expect.any(Object),
      healthcheck: expect.any(Object),
      retryAttempt: 0,
      initialEventId: null,
      txCache: new LRU(100),
      rewardMinBlocks: 300,
      event: fixture,
    };

    await handleVertexAccepted(context as any, undefined as any);

    expect(sendRealtimeTx).toHaveBeenCalledTimes(1);
    const [wallets, tx] = (sendRealtimeTx as jest.Mock).mock.calls[0];

    expect(wallets).toEqual(['wallet_alice']);

    // addresses: the full involved set (transparent + shielded), as an array.
    expect(Array.isArray(tx.addresses)).toBe(true);
    expect(tx.addresses).toEqual(
      expect.arrayContaining(['WTransparentAddress1', 'WShieldedAddress1']),
    );

    // shielded_outputs: lightweight projection only — mode, token_data, decoded
    // address; NO crypto blobs (commitment / range_proof / ephemeral_pubkey).
    expect(tx.shielded_outputs).toEqual([
      { mode: 1, token_data: 1, decoded: { address: 'WShieldedAddress1' } },
    ]);
    expect(tx.shielded_outputs[0]).not.toHaveProperty('commitment');
    expect(tx.shielded_outputs[0]).not.toHaveProperty('range_proof');
    expect(tx.shielded_outputs[0]).not.toHaveProperty('ephemeral_pubkey');
  });

  it('projects a FullyShielded (mode 2) output without token_data and rides its address', async () => {
    expect.hasAssertions();

    const now = Math.floor(Date.now() / 1000);
    await mysql.query(
      `INSERT INTO \`wallet\` (id, xpubkey, auth_xpubkey, status, max_gap, created_at, ready_at)
       VALUES ('wallet_alice', ?, ?, 'ready', 20, ?, ?)`,
      [XPUBKEY, XPUBKEY, now, now],
    );
    await mysql.query(
      `INSERT INTO address (address, wallet_id, \`index\`, bip32_account, transactions)
       VALUES ('WTransparentAddress1', 'wallet_alice', 0, 0, 0)`,
    );

    // Append a FullyShielded (mode 2) output to the mode-1 fixture. Mode 2 carries
    // no token_data, so the projection must omit that field for this entry while
    // still surfacing decoded.address and adding it to the involved-address set.
    const fixture = JSON.parse(JSON.stringify(eventsFixture.VERTEX_WITH_SHIELDED));
    fixture.event.data.shielded_outputs.push({
      mode: 2,
      commitment: '0a'.repeat(33),
      range_proof: '0b'.repeat(64),
      script: '0c'.repeat(20),
      ephemeral_pubkey: '0d'.repeat(33),
      asset_commitment: '0e'.repeat(33),
      surjection_proof: '0f'.repeat(64),
      decoded: { address: 'WShieldedAddress2' },
    });

    const context = {
      socket: expect.any(Object),
      healthcheck: expect.any(Object),
      retryAttempt: 0,
      initialEventId: null,
      txCache: new LRU(100),
      rewardMinBlocks: 300,
      event: fixture,
    };

    await handleVertexAccepted(context as any, undefined as any);

    expect(sendRealtimeTx).toHaveBeenCalledTimes(1);
    const [, tx] = (sendRealtimeTx as jest.Mock).mock.calls[0];

    // The mode-2 entry surfaces decoded.address with NO token_data; the mode-1
    // entry keeps token_data.
    expect(tx.shielded_outputs).toEqual([
      { mode: 1, token_data: 1, decoded: { address: 'WShieldedAddress1' } },
      { mode: 2, decoded: { address: 'WShieldedAddress2' } },
    ]);
    expect(tx.shielded_outputs[1]).not.toHaveProperty('token_data');

    // the mode-2 address rides in the involved-address set
    expect(tx.addresses).toEqual(
      expect.arrayContaining(['WShieldedAddress2']),
    );
  });
});

describe('getWalletBalancesForTx shielded amounts (push payload)', () => {
  it('carries the recovered shielded receive amount as shieldedAmount', async () => {
    expect.hasAssertions();

    const now = Math.floor(Date.now() / 1000);
    await mysql.query(
      `INSERT INTO \`wallet\` (id, xpubkey, auth_xpubkey, status, max_gap, created_at, ready_at)
       VALUES ('wallet_alice', ?, ?, 'ready', 20, ?, ?)`,
      [XPUBKEY, XPUBKEY, now, now],
    );
    await mysql.query(
      `INSERT INTO address (address, wallet_id, \`index\`, bip32_account, transactions)
       VALUES ('WCTSpend1', 'wallet_alice', 7, 2, 0)`,
    );
    await mysql.query(
      `INSERT INTO token (id, name, symbol, total_supply) VALUES ('00', 'Hathor', 'HTR', 0)`,
    );

    // Unified balance map for the vertex: a recovered shielded HTR receive of
    // 150 for the owned address (transparent columns stay zero).
    const addressBalanceMap = {
      WCTSpend1: TokenBalanceMap.fromShielded('00', 150n, false),
    };
    const tx = { tx_id: 'tx-shielded-push' } as any;

    const result = await getWalletBalancesForTx(mysql, tx, addressBalanceMap);

    expect(result.wallet_alice).toBeDefined();
    const tokenBalance = result.wallet_alice.walletBalanceForTx[0];
    expect(tokenBalance.tokenId).toBe('00');
    // transparent total stays zero; the shielded receive rides in shieldedAmount.
    expect(tokenBalance.total).toBe(0n);
    expect(tokenBalance.shieldedAmount).toBe(150n);
  });

  it('reports shieldedAmount = 0 for a shielded spend (never negative)', async () => {
    expect.hasAssertions();

    const now = Math.floor(Date.now() / 1000);
    await mysql.query(
      `INSERT INTO \`wallet\` (id, xpubkey, auth_xpubkey, status, max_gap, created_at, ready_at)
       VALUES ('wallet_alice', ?, ?, 'ready', 20, ?, ?)`,
      [XPUBKEY, XPUBKEY, now, now],
    );
    await mysql.query(
      `INSERT INTO address (address, wallet_id, \`index\`, bip32_account, transactions)
       VALUES ('WCTSpend1', 'wallet_alice', 7, 2, 0)`,
    );
    await mysql.query(
      `INSERT INTO token (id, name, symbol, total_supply) VALUES ('00', 'Hathor', 'HTR', 0)`,
    );

    // A shielded SPEND contributes a negative shielded delta; the gross-received
    // accumulator (shieldedAmount) must stay 0, not go negative.
    const addressBalanceMap = {
      WCTSpend1: TokenBalanceMap.fromShielded('00', -150n, false),
    };
    const tx = { tx_id: 'tx-shielded-spend' } as any;

    const result = await getWalletBalancesForTx(mysql, tx, addressBalanceMap);

    const tokenBalance = result.wallet_alice.walletBalanceForTx[0];
    expect(tokenBalance.total).toBe(0n);
    expect(tokenBalance.shieldedAmount).toBe(0n);
  });

  it('reports gross received (not net) when the same token is both received and spent', async () => {
    expect.hasAssertions();

    const now = Math.floor(Date.now() / 1000);
    await mysql.query(
      `INSERT INTO \`wallet\` (id, xpubkey, auth_xpubkey, status, max_gap, created_at, ready_at)
       VALUES ('wallet_alice', ?, ?, 'ready', 20, ?, ?)`,
      [XPUBKEY, XPUBKEY, now, now],
    );
    await mysql.query(
      `INSERT INTO address (address, wallet_id, \`index\`, bip32_account, transactions)
       VALUES ('WCTSpend1', 'wallet_alice', 7, 2, 0)`,
    );
    await mysql.query(
      `INSERT INTO token (id, name, symbol, total_supply) VALUES ('00', 'Hathor', 'HTR', 0)`,
    );

    // Same token, same tx: a shielded receive of 100 and a shielded spend of 300.
    // The net shielded delta is -200, but shieldedAmount tracks GROSS received,
    // so it must report 100 (not the -200 net, nor 0).
    const addressBalanceMap = {
      WCTSpend1: TokenBalanceMap.merge(
        TokenBalanceMap.fromShielded('00', 100n, false),
        TokenBalanceMap.fromShielded('00', -300n, false),
      ),
    };
    const tx = { tx_id: 'tx-shielded-mixed' } as any;

    const result = await getWalletBalancesForTx(mysql, tx, addressBalanceMap);

    const tokenBalance = result.wallet_alice.walletBalanceForTx[0];
    expect(tokenBalance.total).toBe(0n);
    expect(tokenBalance.shieldedAmount).toBe(100n);
  });
});

describe('sortBalanceValueByAbsTotal shielded-aware ordering', () => {
  it('ranks a shielded receive ahead of a smaller transparent movement', () => {
    expect.hasAssertions();

    const transparent = { tokenId: 'T', total: 10n, shieldedAmount: 0n } as any;
    const shielded = { tokenId: 'S', total: 0n, shieldedAmount: 500n } as any;

    // Pre-shielded-aware sort keyed on abs(total) alone would leave the shielded
    // entry (total 0) last; the combined-magnitude key must rank it first.
    expect([transparent, shielded].sort(sortBalanceValueByAbsTotal)[0].tokenId).toBe('S');
    expect([shielded, transparent].sort(sortBalanceValueByAbsTotal)[0].tokenId).toBe('S');
  });

  it('treats equal combined magnitude as a tie (returns 0, preserves order)', () => {
    expect.hasAssertions();

    // Both have combined magnitude 150: one all-transparent, one transparent +
    // shielded. Equal magnitude must compare as 0 so the comparator honours the
    // sort contract (the old `>= 0n` form wrongly returned -1 on ties).
    const a = { tokenId: 'A', total: 150n, shieldedAmount: 0n } as any;
    const b = { tokenId: 'B', total: 100n, shieldedAmount: 50n } as any;

    expect(sortBalanceValueByAbsTotal(a, b)).toBe(0);
    expect([a, b].sort(sortBalanceValueByAbsTotal).map((x) => x.tokenId)).toEqual(['A', 'B']);
    expect([b, a].sort(sortBalanceValueByAbsTotal).map((x) => x.tokenId)).toEqual(['B', 'A']);
  });
});
