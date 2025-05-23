/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { APIGatewayProxyHandler, Handler, SNSEvent } from 'aws-lambda';
import { LambdaClient, InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import 'source-map-support/register';

import { ApiError } from '@src/api/errors';
import {
  addNewAddresses,
  createWallet,
  generateAddresses,
  getWallet,
  initWalletBalance,
  initWalletTxHistory,
  updateExistingAddresses,
  updateWalletStatus,
  updateWalletAuthXpub,
} from '@src/db';
import { WalletStatus } from '@src/types';
import {
  closeDbConnection,
  getDbConnection,
  getWalletId,
  verifySignature,
  getAddressFromXpub,
  confirmFirstAddress,
  validateAuthTimestamp,
  AUTH_MAX_TIMESTAMP_SHIFT_IN_SECONDS,
} from '@src/utils';
import { closeDbAndGetError, warmupMiddleware } from '@src/api/utils';
import { walletIdProxyHandler } from '@src/commons';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import Joi from 'joi';
import createDefaultLogger from '@src/logger';
import { Severity } from '@wallet-service/common/src/types';
import { addAlert } from '@wallet-service/common/src/utils/alerting.utils';
import config from '@src/config';
import errorHandler from '@src/api/middlewares/errorHandler';

const mysql = getDbConnection();

const MAX_LOAD_WALLET_RETRIES: number = config.maxLoadWalletRetries;

/*
 * Get the status of a wallet
 *
 * This lambda is called by API Gateway on GET /wallet
 */
export const get: APIGatewayProxyHandler = middy(walletIdProxyHandler(async (walletId) => {
  const status = await getWallet(mysql, walletId);
  if (!status) {
    return closeDbAndGetError(mysql, ApiError.WALLET_NOT_FOUND);
  }

  await closeDbConnection(mysql);

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, status }),
  };
})).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());

// If the env requires to validate the first address
// then we must set the firstAddress field as required
const shouldConfirmFirstAddress = config.confirmFirstAddress;
const firstAddressJoi = shouldConfirmFirstAddress ? Joi.string().required() : Joi.string();

const loadBodySchema = Joi.object({
  xpubkey: Joi.string()
    .required(),
  authXpubkey: Joi.string()
    .required(),
  xpubkeySignature: Joi.string()
    .required(),
  authXpubkeySignature: Joi.string()
    .required(),
  timestamp: Joi.number().positive().required(),
  firstAddress: firstAddressJoi,
});

/**
 * Invoke the loadWalletAsync function
 *
 * @param xpubkey - The xpubkey to load
 * @param maxGap - The max gap
 */
/* istanbul ignore next */
export const invokeLoadWalletAsync = async (xpubkey: string, maxGap: number): Promise<void> => {
  const client = new LambdaClient({
    endpoint: config.stage === 'dev'
      ? 'http://localhost:3002'
      : `https://lambda.${config.awsRegion}.amazonaws.com`,
    region: config.awsRegion,
  });
  const command = new InvokeCommand({
    // FunctionName is composed of: service name - stage - function name
    FunctionName: `${config.serviceName}-${config.stage}-loadWalletAsync`,
    InvocationType: 'Event',
    Payload: JSON.stringify({ xpubkey, maxGap }),
  });

  const response: InvokeCommandOutput = await client.send(command);

  // Event InvocationType returns 202 for a successful invokation
  if (response.StatusCode !== 202) {
    throw new Error('Lambda invoke failed');
  }
};

/**
 * Calls verifySignature for both the wallet's xpub signature and
 * the auth_xpub signature.
 *
 * @param walletId - The wallet id
 * @param timestamp - The timestamp the message has been signed with
 * @param xpubkeyStr - A string with the wallet's xpubkey
 * @param xpubkeySignature - A string with the signature that proves the user owns the xpub
 * @param authXpubkeyStr - A string with the auth xpubkey
 * @param authXpubkeySignature- A string with the signature that proves the user owns the xpub
 */
export const validateSignatures = (
  walletId: string,
  timestamp: number,
  xpubkeyStr: string,
  xpubkeySignature: string,
  authXpubkeyStr: string,
  authXpubkeySignature: string,
): boolean => {
  // verify that the user owns the xpubkey
  const xpubAddress = getAddressFromXpub(xpubkeyStr);
  const xpubValid = verifySignature(xpubkeySignature, timestamp, xpubAddress, walletId.toString());

  // verify that the user owns the auth_xpubkey
  const authXpubAddress = getAddressFromXpub(authXpubkeyStr);
  const authXpubValid = verifySignature(authXpubkeySignature, timestamp, authXpubAddress, walletId.toString());

  return xpubValid && authXpubValid;
};

/*
 * Changes the auth_xpubkey of a wallet after validating the user owns both the xpub and the auth_xpub
 *
 * This lambda is called by API Gateway on PUT /wallet/auth
 */
export const changeAuthXpub: APIGatewayProxyHandler = middy(async (event) => {
  const eventBody = (function parseBody(body) {
    try {
      return JSON.parse(body);
    } catch (e) {
      return null;
    }
  }(event.body));

  // body should have the same schema as load
  const { value, error } = loadBodySchema.validate(eventBody, {
    abortEarly: false,
    convert: false,
  });

  if (error) {
    const details = error.details.map((err) => ({
      message: err.message,
      path: err.path,
    }));

    return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD, { details });
  }

  const xpubkeyStr = value.xpubkey;
  const authXpubkeyStr = value.authXpubkey;

  const timestamp = value.timestamp;
  const xpubkeySignature = value.xpubkeySignature;
  const authXpubkeySignature = value.authXpubkeySignature;

  const [validTimestamp, timestampShift] = validateAuthTimestamp(timestamp, Date.now() / 1000);

  if (!validTimestamp) {
    const details = [{
      message: `The timestamp is shifted ${timestampShift}(s). Limit is ${AUTH_MAX_TIMESTAMP_SHIFT_IN_SECONDS}(s).`,
    }];

    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: ApiError.INVALID_PAYLOAD,
        details,
      }),
    };
  }

  // is wallet already loaded/loading?
  const walletId = getWalletId(xpubkeyStr);
  const wallet = await getWallet(mysql, walletId);

  if (!wallet) {
    return closeDbAndGetError(mysql, ApiError.WALLET_NOT_FOUND);
  }

  if (shouldConfirmFirstAddress) {
    const expectedFirstAddress = value.firstAddress;
    const [firstAddressEqual, firstAddress] = confirmFirstAddress(expectedFirstAddress, xpubkeyStr);

    if (!firstAddressEqual) {
      return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD, {
        message: `Expected first address to be ${expectedFirstAddress} but it is ${firstAddress}`,
      });
    }
  }

  const signaturesValid = validateSignatures(walletId, timestamp, xpubkeyStr, xpubkeySignature, authXpubkeyStr, authXpubkeySignature);

  if (!signaturesValid) {
    await closeDbConnection(mysql);

    const details = [{
      message: 'Signatures are not valid',
    }];

    return {
      statusCode: 403,
      body: JSON.stringify({ success: false, details }),
    };
  }

  await updateWalletAuthXpub(mysql, walletId, authXpubkeyStr);

  const updatedWallet = await getWallet(mysql, walletId);

  await closeDbConnection(mysql);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      status: updatedWallet,
    }),
  };
}).use(cors())
  .use(errorHandler());

/*
 * Load a wallet. First checks if the wallet doesn't exist already and then call another
 * lamdba to asynchronously add new wallet info to database
 *
 * This lambda is called by API Gateway on POST /wallet
 */
export const load: APIGatewayProxyHandler = middy(async (event) => {
  const logger = createDefaultLogger();
  const eventBody = (function parseBody(body) {
    try {
      return JSON.parse(body);
    } catch (e) {
      return null;
    }
  }(event.body));

  const { value, error } = loadBodySchema.validate(eventBody, {
    abortEarly: false,
    convert: false,
  });

  if (error) {
    const details = error.details.map((err) => ({
      message: err.message,
      path: err.path,
    }));

    return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD, { details });
  }

  const xpubkeyStr = value.xpubkey;
  const authXpubkeyStr = value.authXpubkey;
  const maxGap = config.maxAddressGap;

  const timestamp = value.timestamp;
  const xpubkeySignature = value.xpubkeySignature;
  const authXpubkeySignature = value.authXpubkeySignature;

  const [validTimestamp, timestampShift] = validateAuthTimestamp(timestamp, Date.now() / 1000);

  if (!validTimestamp) {
    const details = [{
      message: `The timestamp is shifted ${timestampShift}(s). Limit is ${AUTH_MAX_TIMESTAMP_SHIFT_IN_SECONDS}(s).`,
    }];

    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: ApiError.INVALID_PAYLOAD,
        details,
      }),
    };
  }

  // is wallet already loaded/loading?
  const walletId = getWalletId(xpubkeyStr);
  let wallet = await getWallet(mysql, walletId);

  // check if wallet is already loaded so we can fail early
  if (wallet) {
    if (wallet.status === WalletStatus.READY
      || wallet.status === WalletStatus.CREATING) {
      return closeDbAndGetError(mysql, ApiError.WALLET_ALREADY_LOADED, { status: wallet });
    }

    if (wallet.status === WalletStatus.ERROR
        && wallet.retryCount >= MAX_LOAD_WALLET_RETRIES) {
      return closeDbAndGetError(mysql, ApiError.WALLET_MAX_RETRIES, { status: wallet });
    }
  }

  if (shouldConfirmFirstAddress) {
    const expectedFirstAddress = value.firstAddress;
    const [firstAddressEqual, firstAddress] = confirmFirstAddress(expectedFirstAddress, xpubkeyStr);

    if (!firstAddressEqual) {
      return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD, {
        message: `Expected first address to be ${expectedFirstAddress} but it is ${firstAddress}`,
      });
    }
  }

  if (!validateSignatures(walletId, timestamp, xpubkeyStr, xpubkeySignature, authXpubkeyStr, authXpubkeySignature)) {
    await closeDbConnection(mysql);

    const details = [{
      message: 'Signatures are not valid',
    }];

    return {
      statusCode: 403,
      body: JSON.stringify({ success: false, details }),
    };
  }

  // if wallet does not exist at this point, we should add it to the wallet table with 'creating' status
  if (!wallet) {
    wallet = await createWallet(mysql, walletId, xpubkeyStr, authXpubkeyStr, maxGap);
  }

  try {
    /* This calls the lambda function as a "Event", so we don't care here for the response,
     * we only care if the invokation failed or not
     */
    await invokeLoadWalletAsync(xpubkeyStr, maxGap);
  } catch (e) {
    logger.error(e);
    const newRetryCount = wallet.retryCount ? wallet.retryCount + 1 : 1;
    // update wallet status to 'error'
    await updateWalletStatus(mysql, walletId, WalletStatus.ERROR, newRetryCount);

    // refresh the variable with latest status, so we can return it properly
    wallet = await getWallet(mysql, walletId);
  }

  await closeDbConnection(mysql);

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, status: wallet }),
  };
}).use(cors())
  .use(warmupMiddleware())
  .use(errorHandler());

interface LoadEvent {
  source?: string;
  xpubkey: string;
  maxGap: number;
}

interface LoadResult {
  success: boolean;
  walletId: string;
  xpubkey: string;
}

/*
 * This lambda will be started by a SNSMessage on the load failed SNS configured
 * in serverless.yml. It will receive all wallet load failed events published on
 * the loadWalletAsync DLQ SNS topic
 *
 * The event will be a SNSEvent, here is an example of the Message attribute:
 * {"xpubkey":"xpub","maxGap":20}
 */
export const loadWalletFailed: Handler<SNSEvent> = async (event) => {
  const logger = createDefaultLogger();
  const records = event.Records;

  try {
    for (let i = 0; i < records.length; i++) {
      const snsEvent = records[i].Sns;
      const { RequestID, ErrorMessage } = snsEvent.MessageAttributes;

      // Process each failed load wallet event
      const loadEvent: LoadEvent = JSON.parse(snsEvent.Message) as unknown as LoadEvent;

      if (!loadEvent.xpubkey) {
        logger.error('Received wallet load fail message from SNS but no xpubkey received');
        await addAlert(
          'Wallet failed to load, but no xpubkey received.',
          `An event reached loadWalletFailed lambda but the xpubkey was not sent. This indicates that a wallet has failed to load and we weren't able to recover, please check the logs as soon as possible.`,
          Severity.MAJOR,
          {
            RequestID: RequestID.Value,
            ErrorMessage: ErrorMessage.Value,
          },
          logger,
        );
        continue;
      }

      const walletId = getWalletId(loadEvent.xpubkey);

      // update wallet status to 'error' and set the number of retries to MAX so
      // it doesn't get retried
      await updateWalletStatus(mysql, walletId, WalletStatus.ERROR, MAX_LOAD_WALLET_RETRIES);

      logger.error(`${walletId} failed to load.`);
      logger.error({
        walletId,
        RequestID: RequestID.Value,
        ErrorMessage: ErrorMessage.Value,
      });

      await addAlert(
        'A wallet failed to load in the wallet-service',
        `The wallet with id ${walletId} failed to load on the wallet-service. Please check the logs.`,
        Severity.MINOR,
        {
          walletId,
          RequestID: RequestID.Value,
          ErrorMessage: ErrorMessage.Value,
        },
        logger,
      );
    }
  } catch (e) {
    logger.error('Error during loadWalletFailed', e);
    await addAlert(
      'Failed to handle loadWalletFailed event',
      `Failed to process the loadWalletFailed event. This indicates that wallets failed to load and we weren't able to recover, please check the logs as soon as possible.`,
      // This is major because the user will be stuck in a loading cycle
      Severity.MAJOR,
      { event },
      logger,
    );
  }
};

/*
 * This does the "heavy" work when loading a new wallet, updating the database tables accordingly. It
 * expects a wallet entry already on the database
 *
 * This lambda is called async by another lambda, the one reponsible for the load wallet API
 */
export const loadWallet: Handler<LoadEvent, LoadResult> = async (event) => {
  const logger = createDefaultLogger();
  // Can't use a middleware on this event, so we should just check the source (added by the warmup plugin) as
  // our default middleware does
  if (event.source === 'serverless-plugin-warmup') {
    return {
      success: true,
      walletId: '',
      xpubkey: '',
    };
  }

  const xpubkey = event.xpubkey;
  const maxGap = event.maxGap;
  const walletId = getWalletId(xpubkey);

  try {
    const { addresses, existingAddresses, newAddresses, lastUsedAddressIndex } = await generateAddresses(mysql, xpubkey, maxGap);

    // update address table with new addresses
    await addNewAddresses(mysql, walletId, newAddresses, lastUsedAddressIndex);

    // update existing addresses' walletId and index
    await updateExistingAddresses(mysql, walletId, existingAddresses);

    // from address_tx_history, update wallet_tx_history
    await initWalletTxHistory(mysql, walletId, addresses);

    // from address_balance table, update balance table
    await initWalletBalance(mysql, walletId, addresses);

    // update wallet status to 'ready'
    await updateWalletStatus(mysql, walletId, WalletStatus.READY);

    await closeDbConnection(mysql);

    return {
      success: true,
      walletId,
      xpubkey,
    };
  } catch (e) {
    logger.error('Erroed on loadWalletAsync: ', e);

    const wallet = await getWallet(mysql, walletId);
    const newRetryCount = wallet.retryCount ? wallet.retryCount + 1 : 1;

    await updateWalletStatus(mysql, walletId, WalletStatus.ERROR, newRetryCount);

    return {
      success: false,
      walletId,
      xpubkey,
    };
  }
};
