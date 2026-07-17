/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { APIGatewayProxyHandler, Handler, SNSEvent } from 'aws-lambda';
import { InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import 'source-map-support/register';

import { createLambdaClient } from '@src/utils/aws.utils';
import { ApiError } from '@src/api/errors';
import {
  createWallet,
  generateAddresses,
  getWallet,
  updateExistingAddresses,
  updateWalletStatus,
  updateWalletAuthXpub,
  registerWalletShieldedKeys,
  casWalletErrorToCreating,
  pinLegacyLoadFailed,
  pinShieldedLoadFailed,
  upsertNewAddresses,
  advanceLastUsedShieldedIndex,
  markWalletLoadReady,
  markWalletLoadError,
  markLegacyLoadError,
} from '@src/db';
import {
  GenerateShieldedAddresses,
  generateShieldedAddresses,
  upsertShieldedAddressOwnership,
  getWalletCtSpendAddresses,
  markShieldedCatchupDone,
  rebuildShieldedAddressBalances,
  rebuildShieldedAddressTxHistory,
  rebuildWalletBalance,
  rebuildWalletTxHistory,
} from '@src/db/shielded';
import { findAndRewindShielded } from '@src/shieldedRecovery';
import {
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  computeUnifiedStatus,
} from '@src/db/utils';
import { WalletStatus, Wallet } from '@src/types';
import {
  closeDbConnection,
  getDbConnection,
  getWalletId,
  verifySignature,
  verifyMessageSignature,
  buildAuthMessage,
  getAddressFromXpub,
  confirmFirstAddress,
  validateAuthTimestamp,
  AUTH_MAX_TIMESTAMP_SHIFT_IN_SECONDS,
} from '@src/utils';
import { deriveCtAddress, isNeuteredXpub } from '@wallet-service/common/src/crypto/shieldedAddress';
import { Network } from '@hathor/wallet-lib';
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

/**
 * Alert-safe error detail. `String(e)` drops the stack of a real Error, leaving
 * the alert with only a message and no way to join it to the logged throw.
 */
const errorDetail = (e: unknown): string => (
  e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e)
);

// Network instance used to encode shielded (ct) addresses — carries the
// shielded/p2pkh version bytes that address derivation reads.
const shieldedNetwork = new Network(config.network);

/**
 * Shape a wallet row into the API status payload: the `status` field is the
 * unified legacy+shielded lifecycle value, and the two shielded fields are
 * surfaced for clients that use them. Scan/spend keys are deliberately omitted —
 * `scan_xpriv` is a secret and must never leave the service.
 */
export const toWalletStatusResponse = (wallet: Wallet): Record<string, unknown> => ({
  walletId: wallet.walletId,
  xpubkey: wallet.xpubkey,
  authXpubkey: wallet.authXpubkey,
  status: computeUnifiedStatus(wallet.status, wallet.ctStatus ?? 'none'),
  retryCount: wallet.retryCount,
  maxGap: wallet.maxGap,
  createdAt: wallet.createdAt,
  readyAt: wallet.readyAt,
  lastUsedAddressIndex: wallet.lastUsedAddressIndex,
  shieldedMaxGap: wallet.shieldedMaxGap ?? null,
  lastUsedShieldedIndex: wallet.lastUsedShieldedIndex ?? null,
});

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
    body: JSON.stringify({ success: true, status: toWalletStatusResponse(status) }),
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
  // Optional shielded registration — all-or-none: providing any of these five
  // fields requires all of them.
  scanXpriv: Joi.string(),
  spendXpub: Joi.string(),
  firstCtAddress: Joi.string(),
  spendXpubSignature: Joi.string(),
  ctAddressSignature: Joi.string(),
}).and('scanXpriv', 'spendXpub', 'firstCtAddress', 'spendXpubSignature', 'ctAddressSignature');

/**
 * Invoke the async wallet-load lambda — derives both the legacy and
 * shielded address paths and reconstructs both balances in a single pass.
 *
 * @param xpubkey - The xpubkey to load
 * @param maxGap - The max gap
 */
/* istanbul ignore next */
export const invokeLoadWalletAsync = async (xpubkey: string, maxGap: number): Promise<void> => {
  const client = createLambdaClient({
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
 * @param authXpubkeySignature - A string with the signature that proves the user owns the xpub
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

export interface ShieldedRegistration {
  timestamp: number;
  walletId: string;
  authXpubkey: string;
  scanXpriv: string;
  spendXpub: string;
  firstCtAddress: string;
  spendXpubSignature: string;
  ctAddressSignature: string;
}

type ShieldedValidation = { ok: true } | { ok: false; code: 400 | 403; message: string };

/**
 * Validate the proof accompanying a shielded-key registration:
 *
 *  1. The submitted scanXpriv + spendXpub must re-derive to the submitted
 *     firstCtAddress — this proves they are a matched pair for the same account
 *     and that neither was tampered with in transit.
 *  2. `spendXpubSignature` must be a signature of the spendXpub by the spend key
 *     itself — proving control of the spend key.
 *  3. `ctAddressSignature` must be a signature of the firstCtAddress by the
 *     wallet's auth key — proving the wallet authority consented to these exact
 *     keys. The signed message embeds the timestamp, so it is not replayable.
 *
 * Both signed messages use the canonical `timestamp || walletId || payload`
 * form. Returns `{ ok: true }` or a `{ code, message }` describing the failure.
 */
export const validateShieldedRegistration = (reg: ShieldedRegistration): ShieldedValidation => {
  // 1. matched pair + integrity: re-derive the first ct_address from the keys.
  let derivedCtAddress: string;
  try {
    // The spend key must be public. A private one derives identical child pubkeys, so
    // every check below would pass while handing the service spending authority.
    if (!isNeuteredXpub(reg.spendXpub)) {
      return { ok: false, code: 400, message: 'spendXpub must be a public key, not a private key' };
    }
    derivedCtAddress = deriveCtAddress(reg.scanXpriv, reg.spendXpub, 0, shieldedNetwork).ctAddress;
  } catch (e) {
    return { ok: false, code: 400, message: 'Invalid scanXpriv or spendXpub' };
  }
  if (derivedCtAddress !== reg.firstCtAddress) {
    return { ok: false, code: 400, message: 'firstCtAddress does not match the submitted keys' };
  }

  // 2. spend-key control: the spend key signed its own xpub.
  const spendValid = verifyMessageSignature(
    reg.spendXpubSignature,
    buildAuthMessage(reg.timestamp, reg.walletId, reg.spendXpub),
    getAddressFromXpub(reg.spendXpub),
  );
  if (!spendValid) {
    return { ok: false, code: 403, message: 'spendXpub signature is not valid' };
  }

  // 3. auth consent + anti-replay: the auth key signed the first ct_address.
  const authValid = verifyMessageSignature(
    reg.ctAddressSignature,
    buildAuthMessage(reg.timestamp, reg.walletId, reg.firstCtAddress),
    getAddressFromXpub(reg.authXpubkey),
  );
  if (!authValid) {
    return { ok: false, code: 403, message: 'ctAddress signature is not valid' };
  }

  return { ok: true };
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
      status: toWalletStatusResponse(updatedWallet),
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
  const walletExisted = !!wallet;

  // A request carrying shielded fields (all-or-none, guaranteed by the schema)
  // may be a shielded upgrade of an already-loaded wallet, so the "already
  // loaded" early-return below applies only to legacy-only requests.
  const hasShielded = value.scanXpriv != null;

  // Alert ops + reject when a wallet has failed to load too many times. The cap is
  // shared by the legacy, shielded and upgrade paths.
  const rejectMaxRetries = async () => {
    await addAlert(
      'Wallet load exceeded max retries',
      `Wallet ${walletId} reached the load-retry limit (${MAX_LOAD_WALLET_RETRIES}) and will not be retried.`,
      Severity.MINOR,
      { wallet_id: walletId, retry_count: wallet.retryCount, source: 'wallet-service' },
      logger,
    );
    return closeDbAndGetError(mysql, ApiError.WALLET_MAX_RETRIES, { status: toWalletStatusResponse(wallet) });
  };

  // Client did not send CT keys and the wallet already exists
  // check if wallet is already loaded so we can fail early
  // possibly an old client loading a wallet
  if (wallet && !hasShielded) {
    if (wallet.status === WalletStatus.READY
      || wallet.status === WalletStatus.CREATING) {
      return closeDbAndGetError(mysql, ApiError.WALLET_ALREADY_LOADED, { status: toWalletStatusResponse(wallet) });
    }

    if (wallet.status === WalletStatus.ERROR
        && wallet.retryCount >= MAX_LOAD_WALLET_RETRIES) {
      return rejectMaxRetries();
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

  // Validate the shielded proof before mutating anything, so an invalid shielded
  // upgrade cannot leave the legacy side half-processed.
  if (hasShielded) {
    const reg = validateShieldedRegistration({
      timestamp,
      walletId,
      authXpubkey: authXpubkeyStr,
      scanXpriv: value.scanXpriv,
      spendXpub: value.spendXpub,
      firstCtAddress: value.firstCtAddress,
      spendXpubSignature: value.spendXpubSignature,
      ctAddressSignature: value.ctAddressSignature,
    });
    if (reg.ok === false) {
      await closeDbConnection(mysql);
      return {
        statusCode: reg.code,
        body: JSON.stringify({ success: false, details: [{ message: reg.message }] }),
      };
    }
  }

  // Create the wallet if new — registering the shielded keys in the same insert
  // when this is a fresh shielded registration (rather than create-then-update).
  if (!wallet) {
    wallet = hasShielded
      ? await createWallet(mysql, walletId, xpubkeyStr, authXpubkeyStr, maxGap, {
        scanXpriv: value.scanXpriv,
        spendXpub: value.spendXpub,
        shieldedMaxGap: config.shieldedMaxAddressGap,
      })
      : await createWallet(mysql, walletId, xpubkeyStr, authXpubkeyStr, maxGap);
  }

  /* The async loads below are invoked as "Event", so we don't care about the
   * response here, only whether the invocation itself failed. On failure only the
   * side this request was loading is marked 'error' — an upgrade whose invoke
   * fails must leave the already-ready legacy wallet working — and the latest
   * status is re-read for the response. */
  const onAsyncInvokeError = async (e: unknown): Promise<void> => {
    logger.error(e);
    if (hasShielded) {
      await markWalletLoadError(mysql, walletId, wallet.status !== WalletStatus.READY);
    } else {
      await markLegacyLoadError(mysql, walletId);
    }
    wallet = await getWallet(mysql, walletId);
  };

  /** 409 for a submitted key set that disagrees with the one already stored. */
  const rejectKeysConflict = async () => {
    await closeDbConnection(mysql);
    return {
      statusCode: 409,
      body: JSON.stringify({ success: false, error: ApiError.SHIELDED_KEYS_CONFLICT }),
    };
  };

  if (hasShielded) {
    // Whether this request is the one attaching keys to a legacy wallet, and
    // whether it won that race — only the winner may drive the load.
    let upgrading = false;
    let attachedKeys = false;

    // Reconcile keys for an existing wallet: reject a conflicting set; attach keys
    // to a legacy wallet being upgraded. A fresh wallet already has its keys.
    if (walletExisted) {
      if (wallet.scanXpriv == null) {
        upgrading = true;
        attachedKeys = await registerWalletShieldedKeys(
          mysql, walletId, value.scanXpriv, value.spendXpub, config.shieldedMaxAddressGap,
        );
        if (!attachedKeys) {
          // A concurrent request attached keys between our read and this write.
          // Re-read and hold a differing set to the same conflict rule a
          // sequential submit would have hit.
          wallet = await getWallet(mysql, walletId);
          if (wallet.scanXpriv !== value.scanXpriv || wallet.spendXpub !== value.spendXpub) {
            return rejectKeysConflict();
          }
        }
      } else if (wallet.scanXpriv !== value.scanXpriv || wallet.spendXpub !== value.spendXpub) {
        return rejectKeysConflict();
      }
    }

    // A wallet that already failed too many times is alerted + rejected, not retried.
    if (walletExisted
      && computeUnifiedStatus(wallet.status, wallet.ctStatus ?? 'none') === WalletStatus.ERROR
      && wallet.retryCount >= MAX_LOAD_WALLET_RETRIES) {
      return rejectMaxRetries();
    }

    // (Re)invoke the canonical async load — which derives both the legacy
    // and shielded address paths and reconstructs both balances in one pass —
    // unless this is an identical resubmit on a wallet that is already loaded or in
    // progress. Fresh registrations and upgrades always load; a same-keys resubmit
    // re-loads only to retry a previous failure.
    const settledWithSameKeys = walletExisted
      && wallet.scanXpriv === value.scanXpriv
      && wallet.spendXpub === value.spendXpub
      && computeUnifiedStatus(wallet.status, wallet.ctStatus ?? 'none') !== WalletStatus.ERROR;

    let shouldInvoke: boolean;
    if (upgrading) {
      // Only the request that actually attached the keys drives the upgrade load;
      // the loser of that race would otherwise spawn a duplicate.
      shouldInvoke = attachedKeys;
    } else if (settledWithSameKeys) {
      shouldInvoke = false;
    } else {
      // A retry of an errored load must atomically transition back to creating
      // first — a lost race means another request already spawned the load, so
      // this one must not double-invoke.
      const entryUnified = computeUnifiedStatus(wallet.status, wallet.ctStatus ?? 'none');
      shouldInvoke = entryUnified !== WalletStatus.ERROR
        || await casWalletErrorToCreating(mysql, walletId);
    }

    if (shouldInvoke) {
      try {
        await invokeLoadWalletAsync(xpubkeyStr, maxGap);
      } catch (e) {
        await onAsyncInvokeError(e);
      }
    }
    wallet = await getWallet(mysql, walletId);
  } else {
    // Legacy-only load: the load worker derives the legacy path and
    // reconstructs its balance (shielded steps are no-ops without keys).
    try {
      await invokeLoadWalletAsync(xpubkeyStr, maxGap);
    } catch (e) {
      await onAsyncInvokeError(e);
    }
  }

  await closeDbConnection(mysql);

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, status: toWalletStatusResponse(wallet) }),
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

      // Pin the wallet at the retry cap so it is not retried. A wallet with
      // shielded keys pins its shielded lifecycle too, and an upgrade — whose
      // legacy side was already ready before the crashed load — keeps its
      // working legacy state untouched.
      const failedWallet = await getWallet(mysql, walletId);
      if (failedWallet && failedWallet.scanXpriv != null) {
        if (failedWallet.status !== WalletStatus.READY) {
          await pinLegacyLoadFailed(mysql, walletId, MAX_LOAD_WALLET_RETRIES);
        }
        await pinShieldedLoadFailed(mysql, walletId, MAX_LOAD_WALLET_RETRIES);
      } else {
        await pinLegacyLoadFailed(mysql, walletId, MAX_LOAD_WALLET_RETRIES);
      }

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
 * Canonical async wallet load: derives both the legacy and shielded address
 * paths, claims the ownership rows, and reconstructs both balances in one pass.
 * It expects a wallet entry (with shielded keys, when applicable) already on the
 * database — the load API persists keys before invoking this.
 *
 * Idempotent end to end: derivations are recomputed, claims are upserts, rewinds
 * are guarded by tx_output.recovery_state, and the rebuilds recompute absolutes —
 * so AWS async retries and user-driven re-invocations converge. reconstructWallet
 * runs OUTSIDE any DB transaction (paged crypto must not hold row locks).
 */
export const loadWallet: Handler<LoadEvent, LoadResult> = async (event) => {
  const logger = createDefaultLogger();
  if (event.source === 'serverless-plugin-warmup') {
    return { success: true, walletId: '', xpubkey: '' };
  }

  const { xpubkey, maxGap } = event;
  const walletId = getWalletId(xpubkey);
  // A missing wallet row is an invariant violation (the API creates it before
  // invoking) — throw so the crash channel surfaces the bug.
  const wallet = await getWallet(mysql, walletId);
  if (!wallet) {
    throw new Error(`loadWallet: wallet ${walletId} not found`);
  }
  const legacyWasReady = wallet.status === WalletStatus.READY;
  // consts (not the wallet fields) so the null checks narrow them below
  const scanXpriv = wallet.scanXpriv ?? null;
  const spendXpub = wallet.spendXpub ?? null;
  const hasShieldedKeys = scanXpriv !== null && spendXpub !== null;

  try {
    // 1. Read-only derivation of both windows. Already-claimed shielded rows
    //    are reused from storage, so a retry re-derives nothing.
    const legacy = await generateAddresses(mysql, xpubkey, maxGap);
    const shielded: GenerateShieldedAddresses = scanXpriv !== null && spendXpub !== null
      ? await generateShieldedAddresses(
        mysql,
        walletId,
        scanXpriv,
        spendXpub,
        wallet.shieldedMaxGap ?? config.shieldedMaxAddressGap,
        shieldedNetwork,
      )
      : { rows: [], addresses: [], lastUsedShieldedIndex: null, newRows: [] };

    // 2. One short claim transaction: address ownership + frontier indices.
    await beginTransaction(mysql);
    try {
      await upsertNewAddresses(mysql, walletId, legacy.newAddresses, legacy.lastUsedAddressIndex);
      await updateExistingAddresses(mysql, walletId, legacy.existingAddresses);
      await upsertShieldedAddressOwnership(mysql, walletId, shielded.newRows);
      if (shielded.lastUsedShieldedIndex != null) {
        await advanceLastUsedShieldedIndex(mysql, walletId, shielded.lastUsedShieldedIndex);
      }
      await commitTransaction(mysql);
    } catch (txError) {
      await rollbackTransaction(mysql);
      throw txError;
    }

    // 3. Reconstruction — outside any transaction. The CTSpend set is read back
    //    from the database so previously-claimed rows stay covered on re-loads.
    //    The rewind drains run BEFORE the rebuilds (which recompute absolutes
    //    from tx_output), so everything revealed lands in a single rebuild.
    const ctSpendAddresses = hasShieldedKeys ? await getWalletCtSpendAddresses(mysql, walletId) : [];
    if (hasShieldedKeys) {
      const firstSweep = await findAndRewindShielded(mysql, walletId, logger);
      // Settle drain: a daemon ingest whose ownership check snapshotted the
      // world before our claim committed lands its output unowned moments
      // later — one more (cheap when empty) sweep closes that window.
      const settleSweep = await findAndRewindShielded(mysql, walletId, logger);
      // A rewind that fails is recorded as `recovery_failed` and re-driven by a
      // later catch-up, so the load still completes — but the balance is
      // incomplete until then, so make the count greppable next to the
      // per-output alerts rather than letting it pass silently.
      const failedRewinds = firstSweep.failed + settleSweep.failed;
      if (failedRewinds > 0) {
        logger.error('Shielded outputs failed to recover during load', { walletId, failed: failedRewinds });
      }
      await rebuildShieldedAddressBalances(mysql, ctSpendAddresses);
      await rebuildShieldedAddressTxHistory(mysql, ctSpendAddresses);
    }
    await rebuildWalletBalance(mysql, walletId, [...legacy.addresses, ...ctSpendAddresses]);
    await rebuildWalletTxHistory(mysql, walletId, [...legacy.addresses, ...ctSpendAddresses]);

    if (hasShieldedKeys) {
      const highestDerivedIndex = shielded.rows[shielded.rows.length - 1].index;
      await markShieldedCatchupDone(mysql, walletId, highestDerivedIndex);
      await markWalletLoadReady(mysql, walletId, !legacyWasReady);
    } else {
      // Defensive legacy-only path: no shielded lifecycle is fabricated.
      await updateWalletStatus(mysql, walletId, WalletStatus.READY);
    }

    return { success: true, walletId, xpubkey };
  } catch (e) {
    logger.error('Errored on loadWallet: ', e);
    // The dominant failure here is a dead connection/pool, which would make the
    // recovery writes below throw too. Contain that: a secondary failure must not
    // escape and flip this Lambda from "don't retry" to the crash/DLQ channel,
    // where the same degraded pool is waiting.
    try {
      await addAlert(
        'Wallet load failed',
        `The legacy+shielded load for wallet ${walletId} failed and was marked for retry.`,
        Severity.MINOR,
        { wallet_id: walletId, error: errorDetail(e), source: 'wallet-service' },
        logger,
      );
      if (hasShieldedKeys) {
        await markWalletLoadError(mysql, walletId, !legacyWasReady);
      } else {
        await markLegacyLoadError(mysql, walletId);
      }
    } catch (recoveryError) {
      logger.error('Failed to record the load failure', { walletId, originalError: e, recoveryError });
    }
    return { success: false, walletId, xpubkey };
  } finally {
    // Covers both paths — a throw in the finalize writes must not leak the
    // pooled connection in a long-lived Lambda.
    try {
      await closeDbConnection(mysql);
    } catch (closeError) {
      logger.error('Failed to close the db connection', { walletId, closeError });
    }
  }
};
