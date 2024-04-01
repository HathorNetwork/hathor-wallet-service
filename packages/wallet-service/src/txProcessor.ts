/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Handler } from 'aws-lambda';
import 'source-map-support/register';
import createDefaultLogger from '@src/logger';
import { NftUtils } from '@wallet-service/common/src/utils/nft.utils';

export const CREATE_NFT_MAX_RETRIES = 5;

/**
 * This intermediary handler is responsible for making the final validations and calling
 * the Explorer Service to update a NFT metadata, if needed.
 *
 * @remarks
 * This is a lambda function that should be invoked using the aws-sdk.
 */
export const onNewNftEvent: Handler<
  { nftUid: string },
  { success: boolean, message?: string }
> = async (event, context) => {
  const logger = createDefaultLogger();

  // Logs the request id on every line, so we can see all logs from a request
  logger.defaultMeta = {
    requestId: context.awsRequestId,
  };

  // An invalid event object is a signal of a greater communication problem and should be thrown
  if (!event.nftUid) {
    throw new Error('Missing mandatory parameter nftUid');
  }

  try {
    // Checks existing metadata on this transaction and updates it if necessary
    await NftUtils.createOrUpdateNftMetadata(event.nftUid, CREATE_NFT_MAX_RETRIES, logger);
  } catch (e) {
    logger.error('Errored on onNewNftEvent: ', e);

    // No errors should be thrown from the process, only logged and returned gracefully as a success: false
    return {
      success: false,
      message: `onNewNftEvent failed for token ${(event.nftUid)}`,
    };
  }

  return {
    success: true,
  };
};
