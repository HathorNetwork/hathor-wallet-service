import {
  getFilteredTxOutputs,
  getFilteredUtxos,
} from '@src/api/txOutputs';
import { closeDbConnection, getDbConnection } from '@src/utils';
import {
  addToUtxoTable,
  addToWalletTable,
  addToAddressTable,
  makeGatewayEventWithAuthorizer,
  cleanDatabase,
  ADDRESSES,
  TX_IDS,
} from '@tests/utils';
import { ApiError } from '@src/api/errors';
import { APIGatewayProxyResult } from 'aws-lambda';

const mysql = getDbConnection();

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

test('filter utxos api with invalid parameters', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);
  await addToAddressTable(mysql, [{
    address: ADDRESSES[0],
    index: 0,
    walletId: 'my-wallet',
    transactions: 4,
  }, {
    address: ADDRESSES[1],
    index: 1,
    walletId: 'my-wallet',
    transactions: 4,
  }]);

  const token1 = '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50';

  const utxos = [{
    txId: TX_IDS[0],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 50n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[1],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[1],
    value: 100n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[2],
    value: 150n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 1,
    tokenId: token1,
    address: ADDRESSES[3],
    value: 200n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }];

  await addToUtxoTable(mysql, utxos);

  let event = makeGatewayEventWithAuthorizer('my-wallet', {
    biggerThan: 'invalid-parameter',
    smallerThan: 'invalid-parameter',
  }, null);

  let result = await getFilteredUtxos(event, null, null) as APIGatewayProxyResult;
  let returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toStrictEqual(400);
  expect(returnBody.success).toStrictEqual(false);
  expect(returnBody.details).toHaveLength(2);
  expect(returnBody.error).toStrictEqual(ApiError.INVALID_PAYLOAD);

  // Should complain about missing index

  event = makeGatewayEventWithAuthorizer('my-wallet', {
    txId: TX_IDS[0],
  }, null);

  result = await getFilteredUtxos(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toStrictEqual(400);
  expect(returnBody.success).toStrictEqual(false);
  expect(returnBody.details[0].message).toStrictEqual('"value" contains [txId] without its required peers [index]');

  // tx_output not found should return an empty list

  event = makeGatewayEventWithAuthorizer('my-wallet', {
    txId: TX_IDS[3],
    index: '0', // queryparams expects a string
  }, null);

  result = await getFilteredUtxos(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toStrictEqual(200);
  expect(returnBody.success).toStrictEqual(true);
  expect(returnBody.utxos).toStrictEqual([]);

  // Utxo not from user's wallet

  event = makeGatewayEventWithAuthorizer('my-wallet', {
    txId: TX_IDS[2],
    index: '1',
  }, null);

  result = await getFilteredUtxos(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toStrictEqual(403);
  expect(returnBody.success).toStrictEqual(false);
  expect(returnBody.error).toStrictEqual(ApiError.TX_OUTPUT_NOT_IN_WALLET);
});

test('filter tx_output api with invalid parameters', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);

  await addToAddressTable(mysql, [{
    address: ADDRESSES[0],
    index: 0,
    walletId: 'my-wallet',
    transactions: 4,
  }, {
    address: ADDRESSES[1],
    index: 1,
    walletId: 'my-wallet',
    transactions: 4,
  }]);

  const token1 = '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50';

  const utxos = [{
    txId: TX_IDS[0],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 50n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[1],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[1],
    value: 100n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[2],
    value: 150n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 1,
    tokenId: token1,
    address: ADDRESSES[3],
    value: 200n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }];

  await addToUtxoTable(mysql, utxos);

  let event = makeGatewayEventWithAuthorizer('my-wallet', {
    biggerThan: 'invalid-parameter',
    smallerThan: 'invalid-parameter',
  }, null);

  let result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  let returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toStrictEqual(400);
  expect(returnBody.success).toStrictEqual(false);
  expect(returnBody.details).toHaveLength(2);
  expect(returnBody.error).toStrictEqual(ApiError.INVALID_PAYLOAD);

  // Should complain about missing index

  event = makeGatewayEventWithAuthorizer('my-wallet', {
    txId: TX_IDS[0],
  }, null);

  result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toStrictEqual(400);
  expect(returnBody.success).toStrictEqual(false);
  expect(returnBody.details[0].message).toStrictEqual('"value" contains [txId] without its required peers [index]');

  event = makeGatewayEventWithAuthorizer('my-wallet', {
    txId: TX_IDS[3],
    index: '0', // queryparams expects a string
  }, null);

  // tx_output not found should return an empty list

  result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toStrictEqual(200);
  expect(returnBody.success).toStrictEqual(true);
  expect(returnBody.txOutputs).toStrictEqual([]);

  // Utxo not from user's wallet

  event = makeGatewayEventWithAuthorizer('my-wallet', {
    txId: TX_IDS[2],
    index: '1',
  }, null);

  result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toStrictEqual(403);
  expect(returnBody.success).toStrictEqual(false);
  expect(returnBody.error).toStrictEqual(ApiError.TX_OUTPUT_NOT_IN_WALLET);
});

test('get utxos with wallet id', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);
  await addToAddressTable(mysql, [{
    address: ADDRESSES[0],
    index: 0,
    walletId: 'my-wallet',
    transactions: 4,
  }, {
    address: ADDRESSES[1],
    index: 1,
    walletId: 'my-wallet',
    transactions: 4,
  }]);

  const token1 = '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50';

  const utxos = [{
    txId: TX_IDS[0],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 50n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[1],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 100n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[1],
    value: 150n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 1,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 200n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }];

  await addToUtxoTable(mysql, utxos);

  const event = makeGatewayEventWithAuthorizer('my-wallet', {
    tokenId: token1,
    biggerThan: '50',
    smallerThan: '200',
  }, null);

  const result = await getFilteredUtxos(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);

  const formatUtxo = (utxo, path) => ({
    txId: utxo.txId,
    index: utxo.index,
    tokenId: utxo.tokenId,
    address: utxo.address,
    value: Number(utxo.value),
    authorities: utxo.authorities,
    timelock: utxo.timelock,
    heightlock: utxo.heightlock,
    locked: utxo.locked,
    addressPath: `m/44'/280'/0'/0/${path}`,
    txProposalId: null,
    txProposalIndex: null,
    spentBy: null,
  });

  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.utxos).toHaveLength(2);
  expect(returnBody.utxos[0]).toStrictEqual(formatUtxo(utxos[2], 1));
  expect(returnBody.utxos[1]).toStrictEqual(formatUtxo(utxos[1], 0));
});

test('get tx outputs with wallet id', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);
  await addToAddressTable(mysql, [{
    address: ADDRESSES[0],
    index: 0,
    walletId: 'my-wallet',
    transactions: 4,
  }, {
    address: ADDRESSES[1],
    index: 1,
    walletId: 'my-wallet',
    transactions: 4,
  }]);

  const token1 = '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50';

  const utxos = [{
    txId: TX_IDS[0],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 50n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[1],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 100n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[1],
    value: 150n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 1,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 200n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }];

  await addToUtxoTable(mysql, utxos);

  const event = makeGatewayEventWithAuthorizer('my-wallet', {
    tokenId: token1,
    biggerThan: '50',
    smallerThan: '200',
  }, null);

  const result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);

  const formatUtxo = (utxo, path) => ({
    txId: utxo.txId,
    index: utxo.index,
    tokenId: utxo.tokenId,
    address: utxo.address,
    value: Number(utxo.value),
    authorities: utxo.authorities,
    timelock: utxo.timelock,
    heightlock: utxo.heightlock,
    locked: utxo.locked,
    addressPath: `m/44'/280'/0'/0/${path}`,
    txProposalId: null,
    txProposalIndex: null,
    spentBy: null,
  });

  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.txOutputs).toHaveLength(2);
  expect(returnBody.txOutputs[0]).toStrictEqual(formatUtxo(utxos[2], 1));
  expect(returnBody.txOutputs[1]).toStrictEqual(formatUtxo(utxos[1], 0));
});

test('get authority utxos', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);
  await addToAddressTable(mysql, [{
    address: ADDRESSES[0],
    index: 0,
    walletId: 'my-wallet',
    transactions: 4,
  }, {
    address: ADDRESSES[1],
    index: 1,
    walletId: 'my-wallet',
    transactions: 4,
  }]);

  const token1 = '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50';

  const utxos = [{
    txId: TX_IDS[0],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 0n,
    authorities: 1,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[1],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 0n,
    authorities: 2,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[1],
    value: 0n,
    authorities: 1,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 1,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 0n,
    authorities: 1,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[3],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 150n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }];

  await addToUtxoTable(mysql, utxos);

  const formatUtxo = (utxo, path) => ({
    txId: utxo.txId,
    index: utxo.index,
    tokenId: utxo.tokenId,
    address: utxo.address,
    value: Number(utxo.value),
    authorities: utxo.authorities,
    timelock: utxo.timelock,
    heightlock: utxo.heightlock,
    locked: utxo.locked,
    addressPath: `m/44'/280'/0'/0/${path}`,
    txProposalId: null,
    txProposalIndex: null,
    spentBy: null,
  });

  let event = makeGatewayEventWithAuthorizer('my-wallet', {
    tokenId: token1,
    authority: '1', // Only mint authorities
  }, null);

  let result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  let returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.txOutputs).toHaveLength(3);
  expect(returnBody.txOutputs[0]).toStrictEqual(formatUtxo(utxos[0], 0));
  expect(returnBody.txOutputs[1]).toStrictEqual(formatUtxo(utxos[2], 1));
  expect(returnBody.txOutputs[2]).toStrictEqual(formatUtxo(utxos[3], 0));

  event = makeGatewayEventWithAuthorizer('my-wallet', {
    tokenId: token1,
    authority: '3', // Mint and melt authorities
  }, null);

  result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.txOutputs).toHaveLength(4);
});

test('get a specific utxo', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);
  await addToAddressTable(mysql, [{
    address: ADDRESSES[0],
    index: 0,
    walletId: 'my-wallet',
    transactions: 4,
  }, {
    address: ADDRESSES[1],
    index: 1,
    walletId: 'my-wallet',
    transactions: 4,
  }]);

  const token1 = '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50';

  const utxos = [{
    txId: TX_IDS[0],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 50n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[1],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 100n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[1],
    value: 150n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 1,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 200n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }];

  await addToUtxoTable(mysql, utxos);

  const event = makeGatewayEventWithAuthorizer('my-wallet', {
    txId: TX_IDS[0],
    index: '0',
  }, null);

  const result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);

  const formatUtxo = (utxo, path) => ({
    txId: utxo.txId,
    index: utxo.index,
    tokenId: utxo.tokenId,
    address: utxo.address,
    value: Number(utxo.value),
    authorities: utxo.authorities,
    timelock: utxo.timelock,
    heightlock: utxo.heightlock,
    locked: utxo.locked,
    txProposalId: null,
    txProposalIndex: null,
    addressPath: `m/44'/280'/0'/0/${path}`,
    spentBy: null,
  });

  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.txOutputs).toHaveLength(1);
  expect(returnBody.txOutputs[0]).toStrictEqual(formatUtxo(utxos[0], 0));
});

test('get utxos from addresses that are not my own should fail with ApiError.ADDRESS_NOT_IN_WALLET', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);
  await addToAddressTable(mysql, [{
    address: ADDRESSES[0],
    index: 0,
    walletId: 'my-wallet',
    transactions: 4,
  }, {
    address: ADDRESSES[1],
    index: 1,
    walletId: 'other-wallet',
    transactions: 4,
  }]);

  const token1 = '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50';

  const utxos = [{
    txId: TX_IDS[0],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 50n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[1],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 100n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[1],
    value: 150n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[2],
    index: 1,
    tokenId: token1,
    address: ADDRESSES[1],
    value: 200n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }];

  await addToUtxoTable(mysql, utxos);

  const event = makeGatewayEventWithAuthorizer('my-wallet', null, null, {
    'addresses[]': [ADDRESSES[1]],
  });

  const result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toBe(400);
  expect(returnBody.success).toBe(false);
  expect(returnBody.error).toStrictEqual(ApiError.ADDRESS_NOT_IN_WALLET);
});

test('get spent tx_output', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);
  await addToAddressTable(mysql, [{
    address: ADDRESSES[0],
    index: 0,
    walletId: 'my-wallet',
    transactions: 4,
  }, {
    address: ADDRESSES[1],
    index: 1,
    walletId: 'my-wallet',
    transactions: 4,
  }]);

  const token1 = '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50';

  const txOutputs = [{
    txId: TX_IDS[0],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 50n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: TX_IDS[1],
    index: 0,
    tokenId: token1,
    address: ADDRESSES[0],
    value: 100n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: '004d75c1edd4294379e7e5b7ab6c118c53c8b07a506728feb5688c8d26a97e50',
  }];

  await addToUtxoTable(mysql, txOutputs);

  const event = makeGatewayEventWithAuthorizer('my-wallet', {
    tokenId: token1,
    skipSpent: 'false', // should include TX_IDS[1]
  }, null);

  const result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);

  const formatTxOutput = (txOutput, path) => ({
    ...txOutput,
    value: Number(txOutput.value),
    txProposalIndex: null,
    txProposalId: null,
    addressPath: `m/44'/280'/0'/0/${path}`,
  });

  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.txOutputs).toHaveLength(2);
  expect(returnBody.txOutputs[0]).toStrictEqual(formatTxOutput(txOutputs[1], 0));
  expect(returnBody.txOutputs[1]).toStrictEqual(formatTxOutput(txOutputs[0], 0));
});

test('filter utxos by addresses and max utxos', async () => {
  expect.hasAssertions();

  await addToWalletTable(mysql, [{
    id: 'my-wallet',
    xpubkey: 'xpubkey',
    authXpubkey: 'auth_xpubkey',
    status: 'ready',
    maxGap: 5,
    createdAt: 10000,
    readyAt: 10001,
  }]);

  await addToAddressTable(mysql, [
    { address: ADDRESSES[0], index: 0, walletId: 'my-wallet', transactions: 0 },
    { address: ADDRESSES[1], index: 1, walletId: 'my-wallet', transactions: 0 },
    { address: ADDRESSES[2], index: 2, walletId: 'my-wallet', transactions: 2 },
    { address: ADDRESSES[3], index: 3, walletId: 'my-wallet', transactions: 0 },
    { address: ADDRESSES[4], index: 4, walletId: 'my-wallet', transactions: 3 },
    { address: ADDRESSES[5], index: 5, walletId: 'my-wallet', transactions: 0 },
    { address: ADDRESSES[6], index: 6, walletId: 'my-wallet', transactions: 0 },
    { address: ADDRESSES[7], index: 7, walletId: 'my-wallet', transactions: 0 },
    { address: ADDRESSES[8], index: 8, walletId: 'my-wallet', transactions: 0 },
    { address: ADDRESSES[9], index: 0, walletId: null, transactions: 0 },
    { address: ADDRESSES[10], index: 0, walletId: 'test', transactions: 0 },
  ]);

  await addToUtxoTable(mysql, [{
    txId: 'txId',
    index: 0,
    tokenId: '00',
    address: ADDRESSES[0],
    value: 100n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: 'txId2',
    index: 0,
    tokenId: '00',
    address: ADDRESSES[0],
    value: 50n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }, {
    txId: 'txId3',
    index: 0,
    tokenId: '00',
    address: ADDRESSES[1],
    value: 30n,
    authorities: 0,
    timelock: null,
    heightlock: null,
    locked: false,
    spentBy: null,
  }]);

  const event = makeGatewayEventWithAuthorizer('my-wallet', null, null, null);
  const result = await getFilteredTxOutputs(event, null, null) as APIGatewayProxyResult;
  const returnBody = JSON.parse(result.body as string);

  expect(result.statusCode).toBe(200);
  expect(returnBody.success).toBe(true);
  expect(returnBody.txOutputs.length).toStrictEqual(3);

  const event2 = makeGatewayEventWithAuthorizer('my-wallet', null, null, { 'addresses[]': [ADDRESSES[0]] });
  const result2 = await getFilteredTxOutputs(event2, null, null) as APIGatewayProxyResult;
  const returnBody2 = JSON.parse(result2.body as string);

  expect(result2.statusCode).toBe(200);
  expect(returnBody2.success).toBe(true);
  expect(returnBody2.txOutputs.length).toStrictEqual(2);
  expect(returnBody2.txOutputs[0].address).toStrictEqual(ADDRESSES[0]);
  expect(returnBody2.txOutputs[1].address).toStrictEqual(ADDRESSES[0]);

  const event3 = makeGatewayEventWithAuthorizer('my-wallet', { maxOutputs: '1' }, null, { 'addresses[]': [ADDRESSES[0]] });
  const result3 = await getFilteredTxOutputs(event3, null, null) as APIGatewayProxyResult;
  const returnBody3 = JSON.parse(result3.body as string);

  expect(result3.statusCode).toBe(200);
  expect(returnBody3.success).toBe(true);
  expect(returnBody3.txOutputs.length).toStrictEqual(1);
  expect(returnBody3.txOutputs[0].address).toStrictEqual(ADDRESSES[0]);
});
