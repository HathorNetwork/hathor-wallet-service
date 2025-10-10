/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { APIGatewayProxyResult, APIGatewayTokenAuthorizerEvent, CustomAuthorizerResult } from 'aws-lambda';
import jwt from 'jsonwebtoken';
import bitcore from 'bitcore-lib';

import { roTokenHandler, bearerAuthorizer, tokenHandler } from '@src/api/auth';
import { ApiError } from '@src/api/errors';
import { closeDbConnection, getDbConnection, getWalletId, getAddressFromXpub } from '@src/utils';
import { WalletStatus } from '@src/types';
import {
  XPUBKEY,
  AUTH_XPUBKEY,
  addToWalletTable,
  cleanDatabase,
  makeGatewayEvent,
} from '@tests/utils';
import config from '@src/config';

// Monkey patch bitcore-lib
bitcore.Message.MAGIC_BYTES = Buffer.from('Hathor Signed Message:\n');

const mysql = getDbConnection();

beforeEach(async () => {
  await cleanDatabase(mysql);
});

afterAll(async () => {
  await closeDbConnection(mysql);
});

describe('roTokenHandler', () => {
  it('should return a read-only JWT token for a valid ready wallet', async () => {
    const walletId = getWalletId(XPUBKEY);
    await addToWalletTable(mysql, [{
      id: walletId,
      xpubkey: XPUBKEY,
      authXpubkey: 'xpub-auth',
      status: WalletStatus.READY,
      maxGap: 20,
      createdAt: 10000,
      readyAt: 10001,
    }]);

    const event = makeGatewayEvent({}, JSON.stringify({
      xpubkey: XPUBKEY,
    }));

    const result = await roTokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.token).toBeDefined();

    // Verify JWT structure
    const decoded = jwt.verify(body.token, config.authSecret) as any;
    expect(decoded.wid).toBe(walletId);
    expect(decoded.mode).toBe('ro');
    expect(decoded.jti).toBeDefined();
    expect(decoded.exp).toBeDefined();
    // Should not contain signature data
    expect(decoded.sign).toBeUndefined();
    expect(decoded.ts).toBeUndefined();
    expect(decoded.addr).toBeUndefined();
  });

  it('should return WALLET_NOT_FOUND for non-existent wallet', async () => {
    const event = makeGatewayEvent({}, JSON.stringify({
      xpubkey: XPUBKEY,
    }));

    const result = await roTokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.WALLET_NOT_FOUND);
  });

  it('should return WALLET_NOT_READY for wallet not in READY status', async () => {
    const walletId = getWalletId(XPUBKEY);
    await addToWalletTable(mysql, [{
      id: walletId,
      xpubkey: XPUBKEY,
      authXpubkey: 'xpub-auth',
      status: WalletStatus.CREATING,
      maxGap: 20,
      createdAt: 10000,
      readyAt: null,
    }]);

    const event = makeGatewayEvent({}, JSON.stringify({
      xpubkey: XPUBKEY,
    }));

    const result = await roTokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.WALLET_NOT_READY);
  });

  it('should return INVALID_PAYLOAD for missing xpubkey', async () => {
    const event = makeGatewayEvent({}, JSON.stringify({}));

    const result = await roTokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.INVALID_PAYLOAD);
    expect(body.details).toBeDefined();
    expect(body.details[0].message).toContain('xpubkey');
  });

  it('should return INVALID_PAYLOAD for invalid request body', async () => {
    const event = makeGatewayEvent(null);
    event.body = 'invalid json';

    const result = await roTokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.INVALID_PAYLOAD);
  });
});

describe('tokenHandler (full-access)', () => {
  it('should return INVALID_PAYLOAD for missing required fields', async () => {
    const event = makeGatewayEvent({}, JSON.stringify({}));

    const result = await tokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.INVALID_PAYLOAD);
    expect(body.details).toBeDefined();
  });

  it('should return INVALID_PAYLOAD for invalid JSON body', async () => {
    const event = makeGatewayEvent(null);
    event.body = 'invalid json';

    const result = await tokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.INVALID_PAYLOAD);
  });

  it('should return WALLET_NOT_FOUND for non-existent wallet', async () => {
    const walletId = getWalletId(XPUBKEY);
    const now = Math.floor(Date.now() / 1000);
    const address = getAddressFromXpub(AUTH_XPUBKEY);

    // Create a valid signature
    const message = `${walletId}:${now}`;
    const privateKey = new bitcore.PrivateKey();
    const signature = bitcore.Message(message).sign(privateKey);

    const event = makeGatewayEvent({}, JSON.stringify({
      ts: now,
      xpub: AUTH_XPUBKEY,
      sign: signature,
      walletId,
    }));

    const result = await tokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.WALLET_NOT_FOUND);
  });

  it('should return error for invalid timestamp', async () => {
    const walletId = getWalletId(XPUBKEY);
    await addToWalletTable(mysql, [{
      id: walletId,
      xpubkey: XPUBKEY,
      authXpubkey: AUTH_XPUBKEY,
      status: WalletStatus.READY,
      maxGap: 20,
      createdAt: 10000,
      readyAt: 10001,
    }]);

    const invalidTimestamp = Math.floor(Date.now() / 1000) - 100000; // Very old timestamp
    const address = getAddressFromXpub(AUTH_XPUBKEY);
    const message = `${walletId}:${invalidTimestamp}`;
    const privateKey = new bitcore.PrivateKey();
    const signature = bitcore.Message(message).sign(privateKey);

    const event = makeGatewayEvent({}, JSON.stringify({
      ts: invalidTimestamp,
      xpub: AUTH_XPUBKEY,
      sign: signature,
      walletId,
    }));

    const result = await tokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.AUTH_INVALID_SIGNATURE);
    expect(body.details).toBeDefined();
    expect(body.details[0].message).toContain('timestamp is shifted');
  });

  it('should return error for mismatched auth xpubkey', async () => {
    const walletId = getWalletId(XPUBKEY);
    const wrongAuthXpub = XPUBKEY; // Using XPUBKEY as wrong auth (stored auth is AUTH_XPUBKEY)

    await addToWalletTable(mysql, [{
      id: walletId,
      xpubkey: XPUBKEY,
      authXpubkey: AUTH_XPUBKEY,
      status: WalletStatus.READY,
      maxGap: 20,
      createdAt: 10000,
      readyAt: 10001,
    }]);

    const now = Math.floor(Date.now() / 1000);
    const message = `${walletId}:${now}`;
    const privateKey = new bitcore.PrivateKey();
    const signature = bitcore.Message(message).sign(privateKey);

    const event = makeGatewayEvent({}, JSON.stringify({
      ts: now,
      xpub: wrongAuthXpub,
      sign: signature,
      walletId,
    }));

    const result = await tokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.INVALID_PAYLOAD);
    expect(body.details).toBeDefined();
    expect(body.details[0].message).toContain('does not match');
  });

  it('should return error for invalid signature', async () => {
    const walletId = getWalletId(XPUBKEY);
    await addToWalletTable(mysql, [{
      id: walletId,
      xpubkey: XPUBKEY,
      authXpubkey: AUTH_XPUBKEY,
      status: WalletStatus.READY,
      maxGap: 20,
      createdAt: 10000,
      readyAt: 10001,
    }]);

    const now = Math.floor(Date.now() / 1000);

    const event = makeGatewayEvent({}, JSON.stringify({
      ts: now,
      xpub: AUTH_XPUBKEY,
      sign: 'invalid-signature',
      walletId,
    }));

    const result = await tokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe(ApiError.AUTH_INVALID_SIGNATURE);
  });

  it('should successfully generate a full-access token with valid signature', async () => {
    const walletId = getWalletId(XPUBKEY);
    await addToWalletTable(mysql, [{
      id: walletId,
      xpubkey: XPUBKEY,
      authXpubkey: AUTH_XPUBKEY,
      status: WalletStatus.READY,
      maxGap: 20,
      createdAt: 10000,
      readyAt: 10001,
    }]);

    const now = Math.floor(Date.now() / 1000);
    const address = getAddressFromXpub(AUTH_XPUBKEY);
    const message = `${walletId}:${now}`;

    // Create a proper private key and sign
    const privateKey = new bitcore.PrivateKey();
    const addressFromPrivateKey = privateKey.toAddress();

    // We need to mock verifySignature to return true for this test
    // since we can't easily create a valid signature that matches the stored auth xpubkey
    const originalVerifySignature = require('@src/utils').verifySignature;
    jest.spyOn(require('@src/utils'), 'verifySignature').mockReturnValueOnce(true);

    const signature = bitcore.Message(message).sign(privateKey);

    const event = makeGatewayEvent({}, JSON.stringify({
      ts: now,
      xpub: AUTH_XPUBKEY,
      sign: signature,
      walletId,
    }));

    const result = await tokenHandler(event, null, null) as APIGatewayProxyResult;
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.token).toBeDefined();

    // Verify JWT structure
    const decoded = jwt.verify(body.token, config.authSecret) as any;
    expect(decoded.wid).toBe(walletId);
    expect(decoded.mode).toBe('full');
    expect(decoded.sign).toBeDefined();
    expect(decoded.ts).toBe(now);
    expect(decoded.addr).toBeDefined();

    // Restore original
    jest.restoreAllMocks();
  });
});

describe('bearerAuthorizer with read-only mode', () => {
  it('should authorize read-only token with correct policy', async () => {
    const walletId = getWalletId(XPUBKEY);

    // Generate a read-only JWT token
    const token = jwt.sign(
      {
        wid: walletId,
        mode: 'ro',
      },
      config.authSecret,
      {
        expiresIn: 1800,
        jwtid: 'test-jti',
      },
    );

    const event: APIGatewayTokenAuthorizerEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/GET/wallet/balances',
      authorizationToken: `Bearer ${token}`,
    };

    const result = await bearerAuthorizer(event, null, null) as CustomAuthorizerResult;

    expect(result.principalId).toBe(walletId);
    expect(result.context.walletId).toBe(walletId);
    expect(result.context.mode).toBe('ro');
    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');

    // Check that read-only resources are included
    const statement = result.policyDocument.Statement[0] as any;
    const resources = statement.Resource as string[];
    expect(resources).toContain('arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/*/wallet/balances');
    expect(resources).toContain('arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/*/wallet/status');
    expect(resources).toContain('arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/*/wallet/addresses');
    expect(resources).toContain('arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/*/wallet/history');

    // Should NOT contain write endpoints
    expect(resources).not.toContain('arn:aws:execute-api:us-east-1:123456789012:abcdef123/*/tx/*');
  });

  it('should authorize full-access token with correct policy', async () => {
    const walletId = getWalletId(XPUBKEY);
    const now = Math.floor(Date.now() / 1000);

    // Generate a full-access JWT token
    const token = jwt.sign(
      {
        wid: walletId,
        mode: 'full',
        sign: 'mock-signature',
        ts: now,
        addr: 'mock-address',
      },
      config.authSecret,
      {
        expiresIn: 1800,
        jwtid: 'test-jti',
      },
    );

    const event: APIGatewayTokenAuthorizerEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/POST/tx/proposal',
      authorizationToken: `Bearer ${token}`,
    };

    const result = await bearerAuthorizer(event, null, null) as CustomAuthorizerResult;

    expect(result.principalId).toBe(walletId);
    expect(result.context.walletId).toBe(walletId);
    expect(result.context.mode).toBe('full');

    // Check that full-access resources are included
    const statement = result.policyDocument.Statement[0] as any;
    const resources = statement.Resource as string[];
    expect(resources).toContain('arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/*/wallet/*');
    expect(resources).toContain('arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/*/tx/*');
  });

  it('should default to full mode for legacy tokens without mode field', async () => {
    const walletId = getWalletId(XPUBKEY);
    const now = Math.floor(Date.now() / 1000);

    // Generate a legacy JWT token without mode field
    const token = jwt.sign(
      {
        wid: walletId,
        sign: 'mock-signature',
        ts: now,
        addr: 'mock-address',
      },
      config.authSecret,
      {
        expiresIn: 1800,
        jwtid: 'test-jti',
      },
    );

    const event: APIGatewayTokenAuthorizerEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/GET/wallet/status',
      authorizationToken: `Bearer ${token}`,
    };

    const result = await bearerAuthorizer(event, null, null) as CustomAuthorizerResult;

    expect(result.context.mode).toBe('full');
  });

  it('should reject expired read-only token', async () => {
    const walletId = getWalletId(XPUBKEY);

    // Generate an expired token
    const token = jwt.sign(
      {
        wid: walletId,
        mode: 'ro',
      },
      config.authSecret,
      {
        expiresIn: -1, // Expired
        jwtid: 'test-jti',
      },
    );

    const event: APIGatewayTokenAuthorizerEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/GET/wallet/balances',
      authorizationToken: `Bearer ${token}`,
    };

    await expect(bearerAuthorizer(event, null, null)).rejects.toThrow('Unauthorized');
  });

  it('should reject invalid JWT token', async () => {
    const event: APIGatewayTokenAuthorizerEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/GET/wallet/balances',
      authorizationToken: 'Bearer invalid-token',
    };

    await expect(bearerAuthorizer(event, null, null)).rejects.toThrow('Unauthorized');
  });

  it('should reject missing authorization token', async () => {
    const event: APIGatewayTokenAuthorizerEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/GET/wallet/balances',
      authorizationToken: null,
    };

    await expect(bearerAuthorizer(event, null, null)).rejects.toThrow('Unauthorized');
  });

  it('should deny access for full-access token with invalid signature', async () => {
    const walletId = getWalletId(XPUBKEY);
    const now = Math.floor(Date.now() / 1000);

    // Generate a full-access JWT token with invalid signature
    const token = jwt.sign(
      {
        wid: walletId,
        mode: 'full',
        sign: 'invalid-signature',
        ts: now,
        addr: 'invalid-address',
      },
      config.authSecret,
      {
        expiresIn: 1800,
        jwtid: 'test-jti',
      },
    );

    const event: APIGatewayTokenAuthorizerEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/POST/tx/proposal',
      authorizationToken: `Bearer ${token}`,
    };

    const result = await bearerAuthorizer(event, null, null) as CustomAuthorizerResult;

    expect(result.principalId).toBe(walletId);
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  it('should throw for unknown jwt verification error', async () => {
    // Mock jwt.verify to throw a custom error
    jest.spyOn(jwt, 'verify').mockImplementationOnce(() => {
      const error: any = new Error('Some unknown error');
      error.name = 'UnknownError';
      throw error;
    });

    const event: APIGatewayTokenAuthorizerEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abcdef123/test/GET/wallet/balances',
      authorizationToken: 'Bearer some-token',
    };

    await expect(bearerAuthorizer(event, null, null)).rejects.toThrow('Some unknown error');

    jest.restoreAllMocks();
  });
});
