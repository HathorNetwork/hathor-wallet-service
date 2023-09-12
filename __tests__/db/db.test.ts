import {
  updateTx,
  addOrUpdateTx,
  getDbConnection,
  getTransactionById,
  addUtxos,
  unlockUtxos,
  updateTxOutputSpentBy,
  getTxOutput,
  getTxOutputsBySpent,
  unspendUtxos,
  markUtxosAsVoided,
} from '../../src/db';
import { Connection as MysqlConnection } from 'mysql2/promise';
import { checkUtxoTable, countTxOutputTable, createInput, createOutput } from './utils';
import { isAuthority } from '../../src/utils';

let mysql: MysqlConnection;

beforeAll(async () => {
  const _mysql = await getDbConnection();

  mysql = _mysql;
});

/*
afterAll(async () => {
  mysql.destroy();
});
*/

test('addOrUpdateTx should add weight to a tx', async () => {
  expect.hasAssertions();

  await addOrUpdateTx(mysql, 'txId1', null, 1, 1, 65.4321);
  const tx = await getTransactionById(mysql, 'txId1');

  expect(tx?.weight).toStrictEqual(65.4321);
});

test('updateTx should add height to a tx', async () => {
  expect.hasAssertions();

  await addOrUpdateTx(mysql, 'txId1', null, 1, 1, 60);
  await updateTx(mysql, 'txId1', 5, 1, 1, 60);

  const tx = await getTransactionById(mysql, 'txId1');

  expect(tx?.tx_id).toStrictEqual('txId1');
  expect(tx?.height).toStrictEqual(5);
});

test('addUtxos, getUtxos, unlockUtxos, updateTxOutputSpentBy, unspendUtxos, getTxOutput, getTxOutputsBySpent and markUtxosAsVoided', async () => {
  expect.hasAssertions();

  const txId = 'txId';
  const utxos = [
    { value: 5, address: 'address1', tokenId: 'token1', locked: false },
    { value: 15, address: 'address1', tokenId: 'token1', locked: false },
    { value: 25, address: 'address2', tokenId: 'token2', timelock: 500, locked: true },
    { value: 35, address: 'address2', tokenId: 'token1', locked: false },
    // authority utxo
    { value: 0b11, address: 'address1', tokenId: 'token1', locked: false, tokenData: 129 },
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
      authorities = value;
      value = 0;
    }
    await expect(
      checkUtxoTable(mysql, utxos.length, txId, output.index, token, decoded?.address, value, authorities, decoded?.timelock, null, output.locked),
    ).resolves.toBe(true);
  }

  // empty list should be fine
  await unlockUtxos(mysql, []);

  const inputs = utxos.map((utxo, index) => createInput(
    utxo.value,
    utxo.address,
    txId,
    index,
    utxo.tokenId,
    // @ts-ignore
    utxo.timelock,
  ));

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
      authorities = value;
      value = 0;
    }
    await expect(
      checkUtxoTable(
        mysql,
        utxos.length,
        txId,
        index,
        token,
        decoded?.address,
        value,
        authorities,
        decoded?.timelock,
        null,
        output.locked,
      ),
    ).resolves.toBe(true);
  }

  // unlock the locked one
  const first = {
    tx_id: txId,
    index: 2,
    token: 'token2',
    decoded: {
      address: 'address2',
      type: 'P2PKH',
      timelock: 500,
    },
    token_data: 0,
    value: 25,
    authorities: 0,
    heightlock: null,
    locked: true,
    script: '',
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
    first.decoded.timelock,
    first.heightlock,
    false,
  )).resolves.toBe(true);

  const countBeforeDelete = await countTxOutputTable(mysql);
  expect(countBeforeDelete).toStrictEqual(5);

  await markUtxosAsVoided(mysql, txOutputs);

  const countAfterDelete = await countTxOutputTable(mysql);
  expect(countAfterDelete).toStrictEqual(0);
});
