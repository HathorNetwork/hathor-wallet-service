/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  addMiner,
  addNewAddresses,
  addOrUpdateTx,
  addUtxos,
  fetchAddressBalance,
  fetchAddressTxHistorySum,
  getAddressWalletInfo,
  getBestBlockHeight,
  getDbConnection,
  getExpiredTimelocksUtxos,
  getLastSyncedEvent,
  getLockedUtxoFromInputs,
  getMaxIndicesForWallets,
  getMinersList,
  getTokenInformation,
  getTokenSymbols,
  getTransactionById,
  getTxOutput,
  getTxOutputs,
  getTxOutputsAtHeight,
  getTxOutputsBySpent,
  getTxOutputsFromTx,
  getUtxosLockedAtHeight,
  incrementTokensTxCount,
  markUtxosAsVoided,
  storeTokenInformation,
  unlockUtxos,
  unspendUtxos,
  updateAddressLockedBalance,
  updateAddressTablesWithTx,
  updateLastSyncedEvent,
  updateTxOutputSpentBy,
  updateWalletLockedBalance,
  updateWalletTablesWithTx,
  voidTransaction,
  voidAddressTransaction
} from '../../src/db';
import { Connection } from 'mysql2/promise';
import {
  ADDRESSES,
  addToAddressBalanceTable,
  addToAddressTable,
  addToAddressTxHistoryTable,
  addToTokenTable,
  addToTransactionTable,
  addToUtxoTable,
  addToWalletBalanceTable,
  addToWalletTable,
  checkAddressBalanceTable,
  checkAddressTable,
  checkAddressTxHistoryTable,
  checkTokenTable,
  checkTransactionTable,
  checkUtxoTable,
  checkWalletBalanceTable,
  checkWalletTxHistoryTable,
  cleanDatabase,
  countTxOutputTable,
  createEventTxInput,
  createInput,
  createOutput,
  XPUBKEY,
} from '../utils';
import { isAuthority } from '@wallet-service/common';
import { DbTxOutput, StringMap, TokenInfo, WalletStatus } from '../../src/types';
import { Authorities, TokenBalanceMap } from '@wallet-service/common';
import { constants } from '@hathor/wallet-lib';
import { generateAddresses } from '../../src/utils';

// Use a single mysql connection for all tests
let mysql: Connection;
beforeAll(async () => {
  try {
    mysql = await getDbConnection();
  } catch(e) {
    console.error('Failed to establish db connection', e);
    throw e;
  }
});

afterAll(() => {
  mysql.destroy();
});

beforeEach(async () => {
  await cleanDatabase(mysql);
});

describe('transaction methods', () => {
  test('should insert a new tx to the database', async () => {
    expect.hasAssertions();

    await addOrUpdateTx(mysql, 'txId1', null, 1, 1, 65.4321);
    const tx = await getTransactionById(mysql, 'txId1');

    expect(tx?.weight).toStrictEqual(65.4321);
  });

  test('db which is not on our database should return null', async () => {
    expect.hasAssertions();

    await expect(getTransactionById(mysql, 'txId1')).resolves.toBeNull();
  });

  test('should update the height on a already existing transaction', async () => {
    expect.hasAssertions();

    await addOrUpdateTx(mysql, 'txId1', null, 1, 1, 65.4321);
    await addOrUpdateTx(mysql, 'txId1', 1, 1, 1, 65.4321);

    const tx = await getTransactionById(mysql, 'txId1');
    expect(tx?.height).toStrictEqual(1);
  });

  test('should be able to get the best block height', async () => {
    expect.hasAssertions();

    await addOrUpdateTx(mysql, 'txId1', 0, 1, 1, 65.4321);
    await addOrUpdateTx(mysql, 'txId2', 2, 1, 1, 65.4321);
    await addOrUpdateTx(mysql, 'txId3', 3, 1, 1, 65.4321);
    await addOrUpdateTx(mysql, 'txId4', 4, 1, 1, 65.4321);

    const bestBlock = await getBestBlockHeight(mysql);
    expect(bestBlock).toStrictEqual(4);
  });
});

describe('tx output methods', () => {
  test('addUtxos, unlockUtxos, updateTxOutputSpentBy, unspendUtxos, getTxOutput, getTxOutputsBySpent and markUtxosAsVoided', async () => {
    expect.hasAssertions();

    const txId = 'txId';
    const utxos = [
      { value: 5n, address: 'address1', tokenId: 'token1', locked: false },
      { value: 15n, address: 'address1', tokenId: 'token1', locked: false },
      { value: 25n, address: 'address2', tokenId: 'token2', timelock: 500, locked: true },
      { value: 35n, address: 'address2', tokenId: 'token1', locked: false },
      // authority utxo
      { value: 0b11n, address: 'address1', tokenId: 'token1', locked: false, tokenData: 129 },
    ];

    // empty list should be fine
    await addUtxos(mysql, txId, []);

    // add to utxo table
    const outputs = utxos.map((utxo, index) => createOutput(
      index,
      utxo.value,
      utxo.address,
      utxo.tokenId,
      utxo.timelock || null,
      utxo.locked,
      utxo.tokenData || 0,
    ));
    await addUtxos(mysql, txId, outputs);

    for (const [_, output] of outputs.entries()) {
      let { value } = output;
      const { token, decoded } = output;
      let authorities = 0;
      if (isAuthority(output.token_data)) {
        authorities = Number(value);
        value = 0n;
      }
      await expect(
        checkUtxoTable(mysql, utxos.length, txId, output.index, token, decoded?.address, value, authorities, decoded?.timelock, null, output.locked),
      ).resolves.toBe(true);
    }


    // get an unspent tx output
    expect(await getTxOutput(mysql, txId, 0, true)).toStrictEqual({
      txId: 'txId',
      index: 0,
      tokenId: utxos[0].tokenId,
      address: utxos[0].address,
      value: utxos[0].value,
      authorities: 0,
      timelock: null,
      heightlock: null,
      locked: false,
      spentBy: null,
      txProposalId: null,
      txProposalIndex: null,
    });

    // empty list should be fine
    await unlockUtxos(mysql, []);

    const inputs = utxos.map((utxo, index) => createInput(utxo.value, utxo.address, txId, index, utxo.tokenId, utxo.timelock));

    // set tx_outputs as spent
    await updateTxOutputSpentBy(mysql, inputs, txId);

    // get a spent tx output
    expect(await getTxOutput(mysql, txId, 0, false)).toStrictEqual({
      txId: 'txId',
      index: 0,
      tokenId: utxos[0].tokenId,
      address: utxos[0].address,
      value: utxos[0].value,
      authorities: 0,
      timelock: null,
      heightlock: null,
      locked: false,
      spentBy: txId,
      txProposalId: null,
      txProposalIndex: null,
    });

    // if the tx output is not found, it should return null
    expect(await getTxOutput(mysql, 'unknown-tx-id', 0, false)).toBeNull();

    await expect(checkUtxoTable(mysql, 0)).resolves.toBe(true);

    const spentTxOutputs = await getTxOutputsBySpent(mysql, [txId]);
    expect(spentTxOutputs).toHaveLength(5);

    const txOutputs = utxos.map((utxo, index) => ({
      ...utxo,
      txId,
      authorities: 0,
      heightlock: null,
      timelock: null,
      index,
    }));

    await unspendUtxos(mysql, txOutputs);

    for (const [index, output] of outputs.entries()) {
      let { value } = output;
      const { token, decoded } = output;
      let authorities = 0;
      if (isAuthority(output.token_data)) {
        authorities = Number(value);
        value = 0n;
      }
      await expect(
        checkUtxoTable(mysql, utxos.length, txId, index, token, decoded?.address, value, authorities, decoded?.timelock, null, output.locked),
      ).resolves.toBe(true);
    }

    // unlock the locked one
    const first = {
      tx_id: txId,
      index: 2,
      token: 'token2',
      token_data: 0,
      decoded: {
        type: 'P2PKH',
        address: 'address2',
        timelock: null,
      },
      script: '',
      value: 25n,
      authorities: 0,
      timelock: 500,
      heightlock: null,
      locked: true,
    };
    await unlockUtxos(mysql, [first]);
    await expect(checkUtxoTable(
      mysql,
      utxos.length,
      first.tx_id,
      first.index,
      first.token,
      first.decoded.address,
      first.value,
      0,
      first.timelock,
      first.heightlock,
      false,
    )).resolves.toBe(true);

    const countBeforeDelete = await countTxOutputTable(mysql);
    expect(countBeforeDelete).toStrictEqual(5);

    await markUtxosAsVoided(mysql, txOutputs);

    const countAfterDelete = await countTxOutputTable(mysql);
    expect(countAfterDelete).toStrictEqual(0);
  });

  test('markUtxosAsVoided should not throw when utxos list is empty', async () => {
    expect.hasAssertions();

    await expect(markUtxosAsVoided(mysql, [])).resolves.not.toThrow();
  });

  test('getTxOutputsFromTx, getTxOutputs, getTxOutput', async () => {
    expect.hasAssertions();

    const txId = 'txId';
    const utxos: DbTxOutput[] = [
      { txId, index: 0, tokenId: 'token1', address: 'address1', value: 5n, authorities: 0, timelock: 0, heightlock: null, locked: false, spentBy: null, txProposalIndex: null, txProposalId: null },
      { txId, index: 1, tokenId: 'token1', address: 'address1', value: 15n, authorities: 0, timelock: 0, heightlock: null, locked: false, spentBy: null, txProposalIndex: null, txProposalId: null},
      { txId, index: 2, tokenId: 'token1', address: 'address1', value: 25n, authorities: 0, timelock: 0, heightlock: null, locked: false, spentBy: null, txProposalIndex: null, txProposalId: null },
      { txId, index: 3, tokenId: 'token1', address: 'address1', value: 1n, authorities: 0, timelock: 0, heightlock: null, locked: false, spentBy: null, txProposalIndex: null, txProposalId: null },
      { txId, index: 4, tokenId: 'token1', address: 'address1', value: 3n, authorities: 0, timelock: 0, heightlock: null, locked: false, spentBy: null, txProposalIndex: null, txProposalId: null },
    ];

    // add to utxo table
    const outputs = utxos.map((utxo, index) => createOutput(
      index,
      utxo.value,
      utxo.address,
      utxo.tokenId,
      utxo.timelock,
      utxo.locked,
      0,
    ));

    await addUtxos(mysql, txId, outputs);

    expect(await getTxOutputsFromTx(mysql, txId)).toStrictEqual(utxos);
    expect(await getTxOutputs(mysql, utxos.map((utxo) => ({txId: utxo.txId, index: utxo.index})))).toStrictEqual(utxos);
    expect(await getTxOutput(mysql, utxos[0].txId, utxos[0].index, false )).toStrictEqual(utxos[0]);
  });

  test('getTxOutputsAtHeight', async () => {
    expect.hasAssertions();

    const txId = 'txId';
    await addOrUpdateTx(mysql, txId, 0, 1, 1, 65);

    const utxos: DbTxOutput[] = [
      { txId, index: 0, tokenId: 'token1', address: 'address1', value: 5n, authorities: 0, timelock: 0, heightlock: null, locked: false, spentBy: null, txProposalIndex: null, txProposalId: null },
      { txId, index: 1, tokenId: 'token1', address: 'address1', value: 15n, authorities: 0, timelock: 0, heightlock: null, locked: false, spentBy: null, txProposalIndex: null, txProposalId: null},
    ];

    // add to utxo table
    const outputs = utxos.map((utxo, index) => createOutput(
      index,
      utxo.value,
      utxo.address,
      utxo.tokenId,
      utxo.timelock,
      utxo.locked,
      0,
    ));

    await addUtxos(mysql, txId, outputs);

    expect(await getTxOutputsAtHeight(mysql, 0)).toStrictEqual(utxos);
  });

  test('getUtxosLockedAtHeight', async () => {
    expect.hasAssertions();

    const txId = 'txId';
    const txId2 = 'txId2';
    const utxos = [
      // no locks
      { value: 5n, address: 'address1', token: 'token1', locked: false },
      // only timelock
      { value: 25n, address: 'address2', token: 'token2', timelock: 50, locked: false },

    ];
    const utxos2 = [
      // only heightlock
      { value: 35n, address: 'address2', token: 'token1', timelock: null, locked: true },
      // timelock and heightlock
      { value: 45n, address: 'address2', token: 'token1', timelock: 100, locked: true },
      { value: 55n, address: 'address2', token: 'token1', timelock: 1000, locked: true },
    ];

    // add to utxo table
    const outputs = utxos.map((utxo, index) => createOutput(index, utxo.value, utxo.address, utxo.token, utxo.timelock, utxo.locked));
    await addUtxos(mysql, txId, outputs, null);
    const outputs2 = utxos2.map((utxo, index) => createOutput(index, utxo.value, utxo.address, utxo.token, utxo.timelock, utxo.locked));
    await addUtxos(mysql, txId2, outputs2, 10);

    // fetch on timestamp=99 and heightlock=10. Should return:
    // { value: 35, address: 'address2', token: 'token1', timelock: null},
    let results = await getUtxosLockedAtHeight(mysql, 99, 10);
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(35n);

    // fetch on timestamp=100 and heightlock=10. Should return:
    // { value: 35, address: 'address2', token: 'token1', timelock: null},
    // { value: 45, address: 'address2', token: 'token1', timelock: 100},
    results = await getUtxosLockedAtHeight(mysql, 100, 10);
    expect(results).toHaveLength(2);
    expect([35n, 45n]).toContain(results[0].value);
    expect([35n, 45n]).toContain(results[1].value);

    // fetch on timestamp=100 and heightlock=9. Should return empty
    results = await getUtxosLockedAtHeight(mysql, 1000, 9);
    expect(results).toStrictEqual([]);

    // unlockedHeight < 0. This means the block is still very early after genesis and no blocks have been unlocked
    results = await getUtxosLockedAtHeight(mysql, 1000, -2);
    expect(results).toStrictEqual([]);
  });

  test('getExpiredTimelocksUtxos', async () => {
    expect.hasAssertions();

    const txId = 'txId';
    const utxos = [
      { value: 5n, address: 'address1', tokenId: 'token1', locked: true },
      { value: 15n, address: 'address1', tokenId: 'token1', locked: true },
      { value: 25n, address: 'address2', tokenId: 'token2', timelock: 100, locked: true },
      { value: 35n, address: 'address2', tokenId: 'token1', timelock: 200, locked: true },
      // authority utxo
      { value: 0b11n, address: 'address1', tokenId: 'token1', timelock: 300, locked: true, tokenData: 129 },
    ];

    // empty list should be fine
    await addUtxos(mysql, txId, []);

    // add to utxo table
    const outputs = utxos.map((utxo, index) => createOutput(
      index,
      utxo.value,
      utxo.address,
      utxo.tokenId,
      utxo.timelock || null,
      utxo.locked,
      utxo.tokenData || 0,
    ));

    await addUtxos(mysql, txId, outputs);

    const unlockedUtxos0: DbTxOutput[] = await getExpiredTimelocksUtxos(mysql, 100);
    const unlockedUtxos1: DbTxOutput[] = await getExpiredTimelocksUtxos(mysql, 101);
    const unlockedUtxos2: DbTxOutput[] = await getExpiredTimelocksUtxos(mysql, 201);
    const unlockedUtxos3: DbTxOutput[] = await getExpiredTimelocksUtxos(mysql, 301);

    expect(unlockedUtxos0).toHaveLength(0);
    expect(unlockedUtxos1).toHaveLength(1);
    expect(unlockedUtxos1[0].value).toStrictEqual(outputs[2].value);
    expect(unlockedUtxos2).toHaveLength(2);
    expect(unlockedUtxos2[1].value).toStrictEqual(outputs[3].value);
    expect(unlockedUtxos3).toHaveLength(3);
    // last one is an authority utxo
    expect(unlockedUtxos3[2].authorities).toStrictEqual(Number(outputs[4].value));
  });

  test('getLockedUtxoFromInputs', async () => {
    expect.hasAssertions();
    const txId = 'txId';
    const utxos = [
      { value: 5n, address: 'address1', token: 'token1', locked: false },
      { value: 25n, address: 'address2', token: 'token2', timelock: 500, locked: true },
      { value: 35n, address: 'address2', token: 'token1', locked: false },
    ];

    // add to utxo table
    const outputs = utxos.map((utxo, index) => createOutput(index, utxo.value, utxo.address, utxo.token, utxo.timelock || null, utxo.locked));
    await addUtxos(mysql, txId, outputs);
    for (const [index, output] of outputs.entries()) {
      const { token, decoded, value } = output;
      await expect(checkUtxoTable(mysql, 3, txId, index, token, decoded?.address, value, 0, decoded?.timelock, null, output.locked)).resolves.toBe(true);
    }

    const inputs = utxos.map((utxo, index) => createEventTxInput(utxo.value, utxo.address, txId, index, utxo.timelock));
    const results = await getLockedUtxoFromInputs(mysql, inputs);
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(25n);
  });
});

describe('address and wallet related tests', () => {
  test('updateAddressTablesWithTx', async () => {
    expect.hasAssertions();
    const address1 = 'address1';
    const address2 = 'address2';
    const token1 = 'token1';
    const token2 = 'token2';
    const token3 = 'token3';
    // we'll add address1 to the address table already, as if it had already received another transaction
    await addToAddressTable(mysql, [
      { address: address1, index: null, walletId: null, transactions: 1 },
    ]);

    const txId1 = 'txId1';
    const timestamp1 = 10;
    const addrMap1 = {
      address1: TokenBalanceMap.fromStringMap({
        token1: { unlocked: 10n, locked: 0n },
        token2: { unlocked: 7n, locked: 0n },
        token3: { unlocked: 2n, locked: 0n, unlockedAuthorities: new Authorities(0b01) },
      }),
      address2: TokenBalanceMap.fromStringMap({ token1: { unlocked: 8n, locked: 0n, unlockedAuthorities: new Authorities(0b01) } }),
    };

    await updateAddressTablesWithTx(mysql, txId1, timestamp1, addrMap1);
    await expect(checkAddressTable(mysql, 2, address1, null, null, 2)).resolves.toBe(true);
    await expect(checkAddressTable(mysql, 2, address2, null, null, 1)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 4, address1, token1, 10n, 0n, null, 1)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 4, address1, token2, 7n, 0n, null, 1)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 4, address1, token3, 2n, 0n, null, 1, 0b01, 0)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 4, address2, token1, 8n, 0n, null, 1, 0b01, 0)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 4, address1, txId1, token1, 10, timestamp1)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 4, address1, txId1, token2, 7, timestamp1)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 4, address1, txId1, token3, 2, timestamp1)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 4, address2, txId1, token1, 8, timestamp1)).resolves.toBe(true);

    // this tx removes an authority for address1,token3
    const txId2 = 'txId2';
    const timestamp2 = 15;
    const addrMap2 = {
      address1: TokenBalanceMap.fromStringMap({ token1: { unlocked: -5n, locked: 0n },
        token3: { unlocked: 6n, locked: 0n, unlockedAuthorities: new Authorities([-1]) } }),
      address2: TokenBalanceMap.fromStringMap({ token1: { unlocked: 8n, locked: 0n, unlockedAuthorities: new Authorities(0b10) },
        token2: { unlocked: 3n, locked: 0n } }),
    };

    await updateAddressTablesWithTx(mysql, txId2, timestamp2, addrMap2);
    await expect(checkAddressTable(mysql, 2, address1, null, null, 3)).resolves.toBe(true);
    await expect(checkAddressTable(mysql, 2, address2, null, null, 2)).resolves.toBe(true);
    // final balance for each (address,token)
    await expect(checkAddressBalanceTable(mysql, 5, address1, 'token1', 5n, 0n, null, 2)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 5, address1, 'token2', 7n, 0n, null, 1)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 5, address1, 'token3', 8n, 0n, null, 2, 0, 0)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 5, address2, 'token1', 16n, 0n, null, 2, 0b11, 0)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 5, address2, 'token2', 3n, 0n, null, 1)).resolves.toBe(true);
    // tx history
    await expect(checkAddressTxHistoryTable(mysql, 8, address1, txId2, token1, -5, timestamp2)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 8, address1, txId2, token3, 6, timestamp2)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 8, address2, txId2, token1, 8, timestamp2)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 8, address2, txId2, token2, 3, timestamp2)).resolves.toBe(true);
    // make sure entries in address_tx_history from txId1 haven't been changed
    await expect(checkAddressTxHistoryTable(mysql, 8, address1, txId1, token1, 10, timestamp1)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 8, address1, txId1, token2, 7, timestamp1)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 8, address1, txId1, token3, 2, timestamp1)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 8, address2, txId1, token1, 8, timestamp1)).resolves.toBe(true);

    // a tx with timelock
    const txId3 = 'txId3';
    const timestamp3 = 20;
    const lockExpires = 5000;
    const addrMap3 = {
      address1: TokenBalanceMap.fromStringMap({ token1: { unlocked: 0n, locked: 3n, lockExpires } }),
    };
    await updateAddressTablesWithTx(mysql, txId3, timestamp3, addrMap3);
    await expect(checkAddressBalanceTable(mysql, 5, address1, 'token1', 5n, 3n, lockExpires, 3)).resolves.toBe(true);

    // another tx, with higher timelock
    const txId4 = 'txId4';
    const timestamp4 = 25;
    const addrMap4 = {
      address1: TokenBalanceMap.fromStringMap({ token1: { unlocked: 0, locked: 2, lockExpires: lockExpires + 1 } }),
    };
    await updateAddressTablesWithTx(mysql, txId4, timestamp4, addrMap4);
    await expect(checkAddressBalanceTable(mysql, 5, address1, 'token1', 5n, 5n, lockExpires, 4)).resolves.toBe(true);

    // another tx, with lower timelock
    const txId5 = 'txId5';
    const timestamp5 = 25;
    const addrMap5 = {
      address1: TokenBalanceMap.fromStringMap({ token1: { unlocked: 0, locked: 2, lockExpires: lockExpires - 1 } }),
    };
    await updateAddressTablesWithTx(mysql, txId5, timestamp5, addrMap5);
    await expect(checkAddressBalanceTable(mysql, 5, address1, 'token1', 5n, 7n, lockExpires - 1, 5)).resolves.toBe(true);

    // We shouldn't throw if the addressBalanceMap is empty:
    await expect(updateAddressTablesWithTx(mysql, txId5, timestamp5, {})).resolves.not.toThrow();
  });

  test('updateAddressLockedBalance', async () => {
    expect.hasAssertions();

    const addr1 = 'address1';
    const addr2 = 'address2';
    const tokenId = 'tokenId';
    const otherToken = 'otherToken';
    const entries = [
      [addr1, tokenId, 50, 20, null, 3, 0, 0b01, 70],
      [addr2, tokenId, 0, 5, null, 1, 0, 0, 10],
      [addr1, otherToken, 5, 5, null, 1, 0, 0, 10],
    ];
    await addToAddressBalanceTable(mysql, entries);

    const addr1Map = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 10, locked: 0, unlockedAuthorities: new Authorities(0b01) } });
    const addr2Map = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 5, locked: 0 } });
    await updateAddressLockedBalance(mysql, { [addr1]: addr1Map, [addr2]: addr2Map });
    await expect(checkAddressBalanceTable(mysql, 3, addr1, tokenId, 60n, 10n, null, 3, 0b01, 0)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 3, addr2, tokenId, 5n, 0n, null, 1)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 3, addr1, otherToken, 5n, 5n, null, 1)).resolves.toBe(true);

    // now pretend there's another locked authority, so final balance of locked authorities should be updated accordingly
    await addToUtxoTable(mysql, [{
      txId: 'txId',
      index: 0,
      tokenId,
      address: addr1,
      value: 0n,
      authorities: 0b01,
      timelock: 10000,
      heightlock: null,
      locked: true,
      spentBy: null,
    }]);
    const newMap = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 0, locked: 0, unlockedAuthorities: new Authorities(0b10) } });
    await updateAddressLockedBalance(mysql, { [addr1]: newMap });
    await expect(checkAddressBalanceTable(mysql, 3, addr1, tokenId, 60n, 10n, null, 3, 0b11, 0b01)).resolves.toBe(true);
  });

  test('updateWalletLockedBalance', async () => {
    expect.hasAssertions();

    const wallet1 = 'wallet1';
    const wallet2 = 'wallet2';
    const tokenId = 'tokenId';
    const otherToken = 'otherToken';
    const now = 1000;

    const entries = [{
      walletId: wallet1,
      tokenId,
      unlockedBalance: 10,
      lockedBalance: 20,
      unlockedAuthorities: 0b01,
      lockedAuthorities: 0,
      timelockExpires: now,
      transactions: 5,
    }, {
      walletId: wallet2,
      tokenId,
      unlockedBalance: 0,
      lockedBalance: 100,
      unlockedAuthorities: 0,
      lockedAuthorities: 0,
      timelockExpires: now,
      transactions: 4,
    }, {
      walletId: wallet1,
      tokenId: otherToken,
      unlockedBalance: 1,
      lockedBalance: 2,
      unlockedAuthorities: 0,
      lockedAuthorities: 0,
      timelockExpires: null,
      transactions: 1,
    }];
    await addToWalletBalanceTable(mysql, entries);

    const wallet1Map = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 15, locked: 0, unlockedAuthorities: new Authorities(0b11) } });
    const wallet2Map = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 50, locked: 0 } });
    await updateWalletLockedBalance(mysql, { [wallet1]: wallet1Map, [wallet2]: wallet2Map });
    await expect(checkWalletBalanceTable(mysql, 3, wallet1, tokenId, 25, 5, now, 5, 0b11, 0)).resolves.toBe(true);
    await expect(checkWalletBalanceTable(mysql, 3, wallet2, tokenId, 50, 50, now, 4)).resolves.toBe(true);
    await expect(checkWalletBalanceTable(mysql, 3, wallet1, otherToken, 1, 2, null, 1)).resolves.toBe(true);

    // now pretend there's another locked authority, so final balance of locked authorities should be updated accordingly
    await addToAddressTable(mysql, [{
      address: 'address1',
      index: 0,
      walletId: wallet1,
      transactions: 1,
    }]);
    await addToAddressBalanceTable(mysql, [['address1', tokenId, 0, 0, null, 1, 0, 0b01, 0]]);
    const newMap = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 0, locked: 0, unlockedAuthorities: new Authorities(0b10) } });
    await updateWalletLockedBalance(mysql, { [wallet1]: newMap });
    await expect(checkWalletBalanceTable(mysql, 3, wallet1, tokenId, 25, 5, now, 5, 0b11, 0b01)).resolves.toBe(true);
  });

  test('getAddressWalletInfo', async () => {
    expect.hasAssertions();
    const wallet1 = { walletId: 'wallet1', xpubkey: 'xpubkey1', authXpubkey: 'authXpubkey', maxGap: 5 };
    const wallet2 = { walletId: 'wallet2', xpubkey: 'xpubkey2', authXpubkey: 'authXpubkey2', maxGap: 5 };
    const finalMap = {
      addr1: wallet1,
      addr2: wallet1,
      addr3: wallet2,
    };

    // populate address table
    for (const [address, wallet] of Object.entries(finalMap)) {
      await addToAddressTable(mysql, [{
        address,
        index: 0,
        walletId: wallet.walletId,
        transactions: 0,
      }]);
    }
    // add address that won't be requested on walletAddressMap
    await addToAddressTable(mysql, [{
      address: 'addr4',
      index: 0,
      walletId: 'wallet3',
      transactions: 0,
    }]);

    // populate wallet table
    for (const wallet of Object.values(finalMap)) {
      const entry = {
        id: wallet.walletId,
        xpubkey: wallet.xpubkey,
        auth_xpubkey: wallet.authXpubkey,
        status: WalletStatus.READY,
        max_gap: wallet.maxGap,
        created_at: 0,
        ready_at: 0,
      };
      await mysql.query('INSERT INTO `wallet` SET ? ON DUPLICATE KEY UPDATE id=id', [entry]);
    }
    // add wallet that should not be on the results
    await addToWalletTable(mysql, [{
      id: 'wallet3',
      xpubkey: 'xpubkey3',
      authXpubkey: 'authxpubkey3',
      status: WalletStatus.READY,
      maxGap: 5,
      createdAt: 0,
      readyAt: 0,
    }]);

    const addressWalletMap = await getAddressWalletInfo(mysql, Object.keys(finalMap));
    expect(addressWalletMap).toStrictEqual(finalMap);

    // Should not throw on empty addresses list
    await expect(getAddressWalletInfo(mysql, [])).resolves.not.toThrow();
  });

  test('updateWalletLockedBalance', async () => {
    expect.hasAssertions();

    const wallet1 = 'wallet1';
    const wallet2 = 'wallet2';
    const tokenId = 'tokenId';
    const otherToken = 'otherToken';
    const now = 1000;

    const entries = [{
      walletId: wallet1,
      tokenId,
      unlockedBalance: 10,
      lockedBalance: 20,
      unlockedAuthorities: 0b01,
      lockedAuthorities: 0,
      timelockExpires: now,
      transactions: 5,
    }, {
      walletId: wallet2,
      tokenId,
      unlockedBalance: 0,
      lockedBalance: 100,
      unlockedAuthorities: 0,
      lockedAuthorities: 0,
      timelockExpires: now,
      transactions: 4,
    }, {
      walletId: wallet1,
      tokenId: otherToken,
      unlockedBalance: 1,
      lockedBalance: 2,
      unlockedAuthorities: 0,
      lockedAuthorities: 0,
      timelockExpires: null,
      transactions: 1,
    }];
    await addToWalletBalanceTable(mysql, entries);

    const wallet1Map = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 15, locked: 0, unlockedAuthorities: new Authorities(0b11) } });
    const wallet2Map = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 50, locked: 0 } });
    await updateWalletLockedBalance(mysql, { [wallet1]: wallet1Map, [wallet2]: wallet2Map });
    await expect(checkWalletBalanceTable(mysql, 3, wallet1, tokenId, 25, 5, now, 5, 0b11, 0)).resolves.toBe(true);
    await expect(checkWalletBalanceTable(mysql, 3, wallet2, tokenId, 50, 50, now, 4)).resolves.toBe(true);
    await expect(checkWalletBalanceTable(mysql, 3, wallet1, otherToken, 1, 2, null, 1)).resolves.toBe(true);

    // now pretend there's another locked authority, so final balance of locked authorities should be updated accordingly
    await addToAddressTable(mysql, [{
      address: 'address1',
      index: 0,
      walletId: wallet1,
      transactions: 1,
    }]);
    await addToAddressBalanceTable(mysql, [['address1', tokenId, 0, 0, null, 1, 0, 0b01, 0]]);
    const newMap = TokenBalanceMap.fromStringMap({ [tokenId]: { unlocked: 0, locked: 0, unlockedAuthorities: new Authorities(0b10) } });
    await updateWalletLockedBalance(mysql, { [wallet1]: newMap });
    await expect(checkWalletBalanceTable(mysql, 3, wallet1, tokenId, 25, 5, now, 5, 0b11, 0b01)).resolves.toBe(true);
  });

  test('should generate addresses correctly', async () => {
    expect.hasAssertions();

    const maxGap = 5;
    const address0 = ADDRESSES[0];
    const address1 = ADDRESSES[1];
    const address4 = ADDRESSES[4];

    // check first with no addresses on database, so it should return only maxGap addresses
    let addresses = await generateAddresses('mainnet', XPUBKEY, 0, maxGap);

    expect(Object.keys(addresses).length).toBe(maxGap);
    expect(addresses[address0]).toBe(0);

    // add address0 to the database with no transactions
    await addToAddressTable(mysql, [{
      address: address0,
      index: 0,
      walletId: 'wallet1',
      transactions: 0,
    }]);

    addresses = await generateAddresses('mainnet', XPUBKEY, 0, maxGap);
    expect(Object.keys(addresses).length).toBe(maxGap);
    expect(addresses[address0]).toBe(0);

    // now mark address0 as used
    let usedIndex = 0;
    await mysql.query('UPDATE `address` SET `transactions` = ? WHERE `address` = ?', [1, address0]);
    addresses = await generateAddresses('mainnet', XPUBKEY, 0, maxGap + usedIndex + 1);
    expect(Object.keys(addresses).length).toBe(maxGap + usedIndex + 1);
    expect(addresses[address0]).toBe(0);

    // add address1 to the database with transactions
    usedIndex = 1;
    await addToAddressTable(mysql, [{
      address: address1,
      index: 1,
      walletId: 'wallet1',
      transactions: 1,
    }]);

    addresses = await generateAddresses('mainnet', XPUBKEY, 0, maxGap + usedIndex + 1);
    expect(Object.keys(addresses).length).toBe(maxGap + usedIndex + 1);
    expect(addresses[address0]).toBe(0);
    expect(addresses[address1]).toBe(1);

    // add address4 to the database with transactions
    usedIndex = 4;
    await addToAddressTable(mysql, [{
      address: address4,
      index: 4,
      walletId: 'wallet1',
      transactions: 1,
    }]);

    addresses = await generateAddresses('mainnet', XPUBKEY, 0, maxGap + usedIndex + 1);
    expect(Object.keys(addresses).length).toBe(maxGap + usedIndex + 1);
    expect(addresses[address0]).toBe(0);
    expect(addresses[address4]).toBe(4);

    // make sure no address was skipped from being generated
    for (const [address, index] of Object.entries(addresses)) {
      expect(ADDRESSES[index]).toBe(address);
    }
  }, 15000);

  test('addNewAddresses', async () => {
    expect.hasAssertions();
    const walletId = 'walletId';

    const addrMap: StringMap<number> = {};
    for (const [index, address] of ADDRESSES.entries()) {
      addrMap[address] = index;
    }

    // test adding empty dict
    await addNewAddresses(mysql, walletId, {}, -1);
    await expect(checkAddressTable(mysql, 0)).resolves.toBe(true);

    // add some addresses
    await addNewAddresses(mysql, walletId, addrMap, -1);
    for (const [index, address] of ADDRESSES.entries()) {
      await expect(checkAddressTable(mysql, ADDRESSES.length, address, index, walletId, 0)).resolves.toBe(true);
    }
  });

  test('updateWalletTablesWithTx', async () => {
    expect.hasAssertions();
    const walletId = 'walletId';
    const walletId2 = 'walletId2';
    const token1 = 'token1';
    const token2 = 'token2';
    const tx1 = 'txId1';
    const tx2 = 'txId2';
    const tx3 = 'txId3';
    const ts1 = 10;
    const ts2 = 20;
    const ts3 = 30;

    await addToAddressTable(mysql, [
      { address: 'addr1', index: 0, walletId, transactions: 1 },
      { address: 'addr2', index: 1, walletId, transactions: 1 },
      { address: 'addr3', index: 2, walletId, transactions: 1 },
      { address: 'addr4', index: 0, walletId: walletId2, transactions: 1 },
    ]);

    // add tx1
    const walletBalanceMap1 = {
      walletId: TokenBalanceMap.fromStringMap({ token1: { unlocked: 5, locked: 0, unlockedAuthorities: new Authorities(0b01) } }),
    };
    await updateWalletTablesWithTx(mysql, tx1, ts1, walletBalanceMap1);
    await expect(checkWalletBalanceTable(mysql, 1, walletId, token1, 5, 0, null, 1, 0b01, 0)).resolves.toBe(true);
    await expect(checkWalletTxHistoryTable(mysql, 1, walletId, token1, tx1, 5, ts1)).resolves.toBe(true);

    // add tx2
    const walletBalanceMap2 = {
      walletId: TokenBalanceMap.fromStringMap(
        {
          token1: { unlocked: -2, locked: 1, lockExpires: 500, unlockedAuthorities: new Authorities(0b11) },
          token2: { unlocked: 7, locked: 0 },
        },
      ),
    };
    await updateWalletTablesWithTx(mysql, tx2, ts2, walletBalanceMap2);
    await expect(checkWalletBalanceTable(mysql, 2, walletId, token1, 3, 1, 500, 2, 0b11, 0)).resolves.toBe(true);
    await expect(checkWalletBalanceTable(mysql, 2, walletId, token2, 7, 0, null, 1)).resolves.toBe(true);
    await expect(checkWalletTxHistoryTable(mysql, 3, walletId, token1, tx1, 5, ts1)).resolves.toBe(true);
    await expect(checkWalletTxHistoryTable(mysql, 3, walletId, token1, tx2, -1, ts2)).resolves.toBe(true);
    await expect(checkWalletTxHistoryTable(mysql, 3, walletId, token2, tx2, 7, ts2)).resolves.toBe(true);

    // add tx3
    const walletBalanceMap3 = {
      walletId: TokenBalanceMap.fromStringMap({ token1: { unlocked: 1, locked: 2, lockExpires: 200, unlockedAuthorities: new Authorities([-1, -1]) } }),
      walletId2: TokenBalanceMap.fromStringMap({ token2: { unlocked: 10, locked: 0 } }),
    };
    // the tx above removes an authority, which will trigger a "refresh" on the available authorities.
    // Let's pretend there's another utxo with some authorities as well
    await addToAddressTable(mysql, [{
      address: 'address1',
      index: 0,
      walletId,
      transactions: 1,
    }]);
    await addToAddressBalanceTable(mysql, [['address1', token1, 0, 0, null, 1, 0b10, 0, 0]]);

    await updateWalletTablesWithTx(mysql, tx3, ts3, walletBalanceMap3);
    await expect(checkWalletBalanceTable(mysql, 3, walletId, token1, 4, 3, 200, 3, 0b10, 0)).resolves.toBe(true);
    await expect(checkWalletBalanceTable(mysql, 3, walletId, token2, 7, 0, null, 1)).resolves.toBe(true);
    await expect(checkWalletBalanceTable(mysql, 3, walletId2, token2, 10, 0, null, 1)).resolves.toBe(true);
    await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token1, tx1, 5, ts1)).resolves.toBe(true);
    await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token1, tx2, -1, ts2)).resolves.toBe(true);
    await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token2, tx2, 7, ts2)).resolves.toBe(true);
    await expect(checkWalletTxHistoryTable(mysql, 5, walletId, token1, tx3, 3, ts3)).resolves.toBe(true);
    await expect(checkWalletTxHistoryTable(mysql, 5, walletId2, token2, tx3, 10, ts3)).resolves.toBe(true);
  });

  test('fetchAddressBalance', async () => {
    expect.hasAssertions();

    const addr1 = 'addr1';
    const addr2 = 'addr2';
    const addr3 = 'addr3';
    const token1 = 'token1';
    const token2 = 'token2';
    const timelock = 500;

    const addressEntries = [
      // address, tokenId, unlocked, locked, lockExpires, transactions
      [addr1, token1, 2, 0, null, 2, 0, 0, 4],
      [addr1, token2, 1, 4, timelock, 1, 0, 0, 5],
      [addr2, token1, 5, 2, null, 2, 0, 0, 10],
      [addr2, token2, 0, 2, null, 1, 0, 0, 2],
      [addr3, token1, 0, 1, null, 1, 0, 0, 1],
      [addr3, token2, 10, 1, null, 1, 0, 0, 11],
    ];

    await addToAddressBalanceTable(mysql, addressEntries);

    const addressBalances = await fetchAddressBalance(mysql, [addr1, addr2, addr3]);

    expect(addressBalances[0].address).toStrictEqual('addr1');
    expect(addressBalances[0].tokenId).toStrictEqual('token1');
    expect(addressBalances[0].unlockedBalance).toStrictEqual(2n);
    expect(addressBalances[0].lockedBalance).toStrictEqual(0n);
    expect(addressBalances[1].address).toStrictEqual('addr1');
    expect(addressBalances[1].tokenId).toStrictEqual('token2');
    expect(addressBalances[1].unlockedBalance).toStrictEqual(1n);
    expect(addressBalances[1].lockedBalance).toStrictEqual(4n);

    expect(addressBalances[2].address).toStrictEqual('addr2');
    expect(addressBalances[2].tokenId).toStrictEqual('token1');
    expect(addressBalances[2].unlockedBalance).toStrictEqual(5n);
    expect(addressBalances[2].lockedBalance).toStrictEqual(2n);
    expect(addressBalances[3].address).toStrictEqual('addr2');
    expect(addressBalances[3].tokenId).toStrictEqual('token2');
    expect(addressBalances[3].unlockedBalance).toStrictEqual(0n);
    expect(addressBalances[3].lockedBalance).toStrictEqual(2n);

    expect(addressBalances[4].address).toStrictEqual('addr3');
    expect(addressBalances[4].tokenId).toStrictEqual('token1');
    expect(addressBalances[4].unlockedBalance).toStrictEqual(0n);
    expect(addressBalances[4].lockedBalance).toStrictEqual(1n);
    expect(addressBalances[5].address).toStrictEqual('addr3');
    expect(addressBalances[5].tokenId).toStrictEqual('token2');
    expect(addressBalances[5].unlockedBalance).toStrictEqual(10n);
    expect(addressBalances[5].lockedBalance).toStrictEqual(1n);
  });

  test('fetchAddressTxHistorySum', async () => {
    expect.hasAssertions();

    const addr1 = 'addr1';
    const addr2 = 'addr2';
    const token1 = 'token1';
    const token2 = 'token2';
    const txId1 = 'txId1';
    const txId2 = 'txId2';
    const txId3 = 'txId3';
    const timestamp1 = 10;
    const timestamp2 = 20;
    const entries = [
      { address: addr1, txId: txId1, tokenId: token1, balance: 10, timestamp: timestamp1 },
      { address: addr1, txId: txId2, tokenId: token1, balance: 20, timestamp: timestamp2 },
      { address: addr1, txId: txId3, tokenId: token1, balance: 30, timestamp: timestamp2 },
      // total: 60
      { address: addr2, txId: txId1, tokenId: token2, balance: 20, timestamp: timestamp1 },
      { address: addr2, txId: txId2, tokenId: token2, balance: 20, timestamp: timestamp2 },
      { address: addr2, txId: txId3, tokenId: token2, balance: 10, timestamp: timestamp2 },
      // total: 50
    ];

    await addToAddressTxHistoryTable(mysql, entries);

    const history = await fetchAddressTxHistorySum(mysql, [addr1, addr2]);

    expect(history[0].balance).toStrictEqual(60n);
    expect(history[1].balance).toStrictEqual(50n);
  });
});

describe('miner list', () => {
  test('getMinersList', async () => {
    expect.hasAssertions();

    await addMiner(mysql, 'address1', 'txId1');
    await addMiner(mysql, 'address2', 'txId2');
    await addMiner(mysql, 'address3', 'txId3');

    let results = await getMinersList(mysql);

    expect(results).toHaveLength(3);
    expect(new Set(results)).toStrictEqual(new Set([
      { address: 'address1', firstBlock: 'txId1', lastBlock: 'txId1', count: 1 },
      { address: 'address2', firstBlock: 'txId2', lastBlock: 'txId2', count: 1 },
      { address: 'address3', firstBlock: 'txId3', lastBlock: 'txId3', count: 1 },
    ]));

    await addMiner(mysql, 'address3', 'txId4');
    await addMiner(mysql, 'address3', 'txId5');

    results = await getMinersList(mysql);

    expect(results).toHaveLength(3);

    expect(new Set(results)).toStrictEqual(new Set([
      { address: 'address1', firstBlock: 'txId1', lastBlock: 'txId1', count: 1 },
      { address: 'address2', firstBlock: 'txId2', lastBlock: 'txId2', count: 1 },
      { address: 'address3', firstBlock: 'txId3', lastBlock: 'txId5', count: 3 },
    ]));
  });
});

describe('token methods', () => {
  test('storeTokenInformation and getTokenInformation', async () => {
    expect.hasAssertions();

    expect(await getTokenInformation(mysql, 'invalid')).toBeNull();

    const info = new TokenInfo('tokenId', 'tokenName', 'TKNS');
    storeTokenInformation(mysql, info.id, info.name, info.symbol);

    expect(info).toStrictEqual(await getTokenInformation(mysql, info.id));
  });

  test('incrementTokensTxCount', async () => {
    expect.hasAssertions();

    const htr = new TokenInfo('00', 'Hathor', 'HTR', 5);
    const token1 = new TokenInfo('token1', 'MyToken1', 'MT1', 10);
    const token2 = new TokenInfo('token2', 'MyToken2', 'MT2', 15);

    await addToTokenTable(mysql, [
      { id: htr.id, name: htr.name, symbol: htr.symbol, transactions: htr.transactions },
      { id: token1.id, name: token1.name, symbol: token1.symbol, transactions: token1.transactions },
      { id: token2.id, name: token2.name, symbol: token2.symbol, transactions: token2.transactions },
    ]);

    await incrementTokensTxCount(mysql, ['token1', '00', 'token2']);

    await expect(checkTokenTable(mysql, 3, [{
      tokenId: token1.id,
      tokenSymbol: token1.symbol,
      tokenName: token1.name,
      transactions: token1.transactions + 1,
    }, {
      tokenId: token2.id,
      tokenSymbol: token2.symbol,
      tokenName: token2.name,
      transactions: token2.transactions + 1,
    }, {
      tokenId: htr.id,
      tokenSymbol: htr.symbol,
      tokenName: htr.name,
      transactions: htr.transactions + 1,
    }])).resolves.toBe(true);
  });
});

describe('sync metadata', () => {
  test('updateLastSyncedEvent, getLastSyncedEvent', async () => {
    expect.hasAssertions();

    await expect(updateLastSyncedEvent(mysql, 5)).resolves.not.toThrow();
    const lastSyncedEvent = await getLastSyncedEvent(mysql);
    expect(lastSyncedEvent?.last_event_id).toStrictEqual(5);
  });
});

// TODO: This test is duplicated from the wallet-service package, we should
// have methods shared between the two projects
describe('getTokenSymbols', () => {
  it('should return a map of token symbol by token id', async () => {
    expect.hasAssertions();

    const tokensToPersist = [
      new TokenInfo('token1', 'tokenName1', 'TKN1'),
      new TokenInfo('token2', 'tokenName2', 'TKN2'),
      new TokenInfo('token3', 'tokenName3', 'TKN3'),
      new TokenInfo('token4', 'tokenName4', 'TKN4'),
      new TokenInfo('token5', 'tokenName5', 'TKN5'),
    ];

    // persist tokens
    for (const eachToken of tokensToPersist) {
      await storeTokenInformation(mysql, eachToken.id, eachToken.name, eachToken.symbol);
    }

    const tokenIdList = tokensToPersist.map((each: TokenInfo) => each.id);
    const tokenSymbolMap = await getTokenSymbols(mysql, tokenIdList);

    expect(tokenSymbolMap).toStrictEqual({
      token1: 'TKN1',
      token2: 'TKN2',
      token3: 'TKN3',
      token4: 'TKN4',
      token5: 'TKN5',
    });
  });

  it('should return null when no token is found', async () => {
    expect.hasAssertions();

    const tokensToPersist = [
      new TokenInfo('token1', 'tokenName1', 'TKN1'),
      new TokenInfo('token2', 'tokenName2', 'TKN2'),
      new TokenInfo('token3', 'tokenName3', 'TKN3'),
      new TokenInfo('token4', 'tokenName4', 'TKN4'),
      new TokenInfo('token5', 'tokenName5', 'TKN5'),
    ];

    // no token persistence

    let tokenIdList = tokensToPersist.map((each: TokenInfo) => each.id);
    let tokenSymbolMap = await getTokenSymbols(mysql, tokenIdList);

    expect(tokenSymbolMap).toStrictEqual({});

    tokenIdList = [];
    tokenSymbolMap = await getTokenSymbols(mysql, tokenIdList);

    expect(tokenSymbolMap).toStrictEqual({});
  });
});

describe('voidTransaction', () => {
  const txId = 'tx1';
  const addr1 = 'addr1';
  const token1 = 'token1';
  const token2 = 'other-token';

  it('should re-calculate address balances properly', async () => {
    expect.hasAssertions();

    await addToTransactionTable(mysql, [{
      txId,
      timestamp: 0,
      version: constants.BLOCK_VERSION,
      voided: false,
      height: 1,
    }]);

    await addToAddressTable(mysql, [{
      address: addr1,
      index: 0,
      walletId: null,
      transactions: 2,
    }]);

    await addToAddressBalanceTable(mysql, [
      [addr1, token1, 50, 5, null, 5, 0, 0, 100],
      [addr1, token2, 25, 10, null, 4, 0, 0, 50],
    ]);

    await addToAddressTxHistoryTable(mysql, [{
      address: addr1,
      txId,
      tokenId: token1,
      balance: 50,
      timestamp: 1,
    }, {
      address: addr1,
      txId,
      tokenId: token2,
      balance: 25,
      timestamp: 1,
    }]);

    const addressBalance: StringMap<TokenBalanceMap> = {
      [addr1]: TokenBalanceMap.fromStringMap({
        [token1]: {
          unlocked: 49,
          locked: 5,
        },
        [token2]: {
          unlocked: 24,
          locked: 10,
        }
      }),
    };

    await voidTransaction(mysql, txId);
    await voidAddressTransaction(mysql, txId, addressBalance, 1);

    await expect(checkAddressBalanceTable(mysql, 2, addr1, token2, 1n, 0n, null, 3)).resolves.toBe(true);
    await expect(checkAddressBalanceTable(mysql, 2, addr1, token1, 1n, 0n, null, 4)).resolves.toBe(true);
    // Address tx history entry should have been deleted for both tokens:
    await expect(checkAddressTxHistoryTable(mysql, 0, addr1, txId, token1, -1, 0)).resolves.toBe(true);
    await expect(checkAddressTxHistoryTable(mysql, 0, addr1, txId, token2, -1, 0)).resolves.toBe(true);

    await expect(checkTransactionTable(mysql, 1, txId, 0, constants.BLOCK_VERSION, true, 1)).resolves.toBe(true);
  });

  it('should not fail when balances are empty (from a tx with no inputs and outputs)', async () => {
    expect.hasAssertions();

    await addToTransactionTable(mysql, [{
      txId,
      timestamp: 0,
      version: constants.BLOCK_VERSION,
      voided: false,
      height: 1,
    }]);

    const addressBalance: StringMap<TokenBalanceMap> = {};

    await expect(voidTransaction(mysql, txId)).resolves.not.toThrow();
    // Tx should be voided
    await expect(checkTransactionTable(mysql, 1, txId, 0, constants.BLOCK_VERSION, true, 1)).resolves.toBe(true);
  });

  it('should throw an error if the transaction is not found in the database', async () => {
    expect.hasAssertions();

    await expect(voidTransaction(mysql, 'mysterious-transaction')).rejects.toThrow('Tried to void a transaction that is not in the database.');
  });
});

describe('address generation and index methods', () => {
  test('generateAddresses should generate correct addresses', async () => {
    expect.hasAssertions();

    const startIndex = 0;
    const count = 3;
    const addresses = await generateAddresses('mainnet', XPUBKEY, startIndex, count);

    // Check if we got the expected number of addresses
    expect(Object.keys(addresses).length).toBe(count);

    // Check if the addresses are mapped to correct indices
    Object.entries(addresses).forEach(([address, index]) => {
      expect(typeof address).toBe('string');
      expect(index).toBeGreaterThanOrEqual(startIndex);
      expect(index).toBeLessThan(startIndex + count);
    });
  });

  test('getMaxIndicesForWallets should return correct indices for multiple wallets', async () => {
    expect.hasAssertions();

    const wallet1 = 'wallet1';
    const wallet2 = 'wallet2';
    const addresses1 = ['addr1', 'addr2', 'addr3'];
    const addresses2 = ['addr4', 'addr5'];
    const indices1 = [5, 10, 15];
    const indices2 = [7, 12];

    // Add addresses for wallet1
    const entries1 = addresses1.map((address, i) => ({
      address,
      index: indices1[i],
      walletId: wallet1,
      transactions: 0,
    }));
    await addToAddressTable(mysql, entries1);

    // Add addresses for wallet2
    const entries2 = addresses2.map((address, i) => ({
      address,
      index: indices2[i],
      walletId: wallet2,
      transactions: 0,
    }));
    await addToAddressTable(mysql, entries2);

    // Test getting indices for both wallets
    const walletData = [
      { walletId: wallet1, addresses: addresses1 },
      { walletId: wallet2, addresses: addresses2 },
    ];
    const indices = await getMaxIndicesForWallets(mysql, walletData);

    // Check wallet1 indices
    const wallet1Indices = indices.get(wallet1);
    expect(wallet1Indices).toBeDefined();
    expect(wallet1Indices?.maxAmongAddresses).toBe(15);
    expect(wallet1Indices?.maxWalletIndex).toBe(15);

    // Check wallet2 indices
    const wallet2Indices = indices.get(wallet2);
    expect(wallet2Indices).toBeDefined();
    expect(wallet2Indices?.maxAmongAddresses).toBe(12);
    expect(wallet2Indices?.maxWalletIndex).toBe(12);

    // Test with empty wallet data
    const emptyIndices = await getMaxIndicesForWallets(mysql, []);
    expect(emptyIndices.size).toBe(0);

    // Test with non-existent wallet
    const nonExistentIndices = await getMaxIndicesForWallets(mysql, [
      { walletId: 'nonexistent', addresses: ['addr1'] }
    ]);
    expect(nonExistentIndices.size).toBe(0);

    // Test with subset of addresses
    const subsetIndices = await getMaxIndicesForWallets(mysql, [
      { walletId: wallet1, addresses: addresses1.slice(0, 2) }
    ]);
    const subsetWallet1 = subsetIndices.get(wallet1);
    expect(subsetWallet1).toBeDefined();
    expect(subsetWallet1?.maxAmongAddresses).toBe(10);
    expect(subsetWallet1?.maxWalletIndex).toBe(15);
  });
});
