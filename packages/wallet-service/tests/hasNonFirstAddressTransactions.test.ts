import { APIGatewayProxyResult } from 'aws-lambda';

import { get } from '@src/api/hasNonFirstAddressTransactions';
import { ApiError } from '@src/api/errors';
import { closeDbConnection, getDbConnection } from '@src/utils';
import {
  ADDRESSES,
  XPUBKEY,
  AUTH_XPUBKEY,
  addToAddressTable,
  addToWalletTable,
  cleanDatabase,
  makeGatewayEventWithAuthorizer,
} from '@tests/utils';

const mysql = getDbConnection();

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

describe('GET /wallet/addresses/has-transactions', () => {
  it('should return 404 when wallet is not found', async () => {
    expect.hasAssertions();

    const event = makeGatewayEventWithAuthorizer('non-existent-wallet', null);
    const result = await get(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body as string);

    expect(result.statusCode).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.WALLET_NOT_FOUND);
  });

  it('should return 400 when wallet is not ready', async () => {
    expect.hasAssertions();

    const walletId = 'wallet-not-ready';
    await addToWalletTable(mysql, [{
      id: walletId,
      xpubkey: XPUBKEY,
      authXpubkey: AUTH_XPUBKEY,
      status: 'creating',
      maxGap: 5,
      createdAt: 10000,
      readyAt: null,
    }]);

    const event = makeGatewayEventWithAuthorizer(walletId, null);
    const result = await get(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body as string);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.WALLET_NOT_READY);
  });

  it('should return hasTransactions=false when no non-first address has transactions', async () => {
    expect.hasAssertions();

    const walletId = 'my-wallet';
    await addToWalletTable(mysql, [{
      id: walletId,
      xpubkey: XPUBKEY,
      authXpubkey: AUTH_XPUBKEY,
      status: 'ready',
      maxGap: 5,
      createdAt: 10000,
      readyAt: 10001,
    }]);
    await addToAddressTable(mysql, [
      { address: ADDRESSES[0], index: 0, walletId, transactions: 10 },
      { address: ADDRESSES[1], index: 1, walletId, transactions: 0 },
    ]);

    const event = makeGatewayEventWithAuthorizer(walletId, null);
    const result = await get(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body as string);

    expect(result.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.hasTransactions).toBe(false);
  });

  it('should return hasTransactions=true when a non-first address has transactions', async () => {
    expect.hasAssertions();

    const walletId = 'my-wallet';
    await addToWalletTable(mysql, [{
      id: walletId,
      xpubkey: XPUBKEY,
      authXpubkey: AUTH_XPUBKEY,
      status: 'ready',
      maxGap: 5,
      createdAt: 10000,
      readyAt: 10001,
    }]);
    await addToAddressTable(mysql, [
      { address: ADDRESSES[0], index: 0, walletId, transactions: 10 },
      { address: ADDRESSES[1], index: 1, walletId, transactions: 5 },
    ]);

    const event = makeGatewayEventWithAuthorizer(walletId, null);
    const result = await get(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body as string);

    expect(result.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.hasTransactions).toBe(true);
  });

  it('should include CORS headers', async () => {
    expect.hasAssertions();

    const walletId = 'my-wallet';
    await addToWalletTable(mysql, [{
      id: walletId,
      xpubkey: XPUBKEY,
      authXpubkey: AUTH_XPUBKEY,
      status: 'ready',
      maxGap: 5,
      createdAt: 10000,
      readyAt: 10001,
    }]);

    const event = makeGatewayEventWithAuthorizer(walletId, null);
    event.httpMethod = 'XXX';
    const result = await get(event, null, null) as APIGatewayProxyResult;

    expect(result.headers).toStrictEqual(
      expect.objectContaining({
        'Access-Control-Allow-Origin': '*',
      }),
    );
  });
});
