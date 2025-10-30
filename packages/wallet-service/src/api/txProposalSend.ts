import { APIGatewayProxyHandler } from 'aws-lambda';
import hathorLib from '@hathor/wallet-lib';

import Joi from 'joi';

import 'source-map-support/register';

import { ApiError } from '@src/api/errors';
import createDefaultLogger from '@src/logger';
import {
  getTxProposal,
  getTxProposalInputs,
  updateTxProposal,
  releaseTxProposalUtxos,
} from '@src/db';
import {
  TxProposalStatus,
  ApiResponse,
} from '@src/types';
import {
  closeDbConnection,
  getDbConnection,
  getUnixTimestamp,
} from '@src/utils';

import {
  walletIdProxyHandler,
} from '@src/commons';

import { closeDbAndGetError } from '@src/api/utils';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import config from '@src/config';
import errorHandler from '@src/api/middlewares/errorHandler';

const mysql = getDbConnection();

const paramsSchema = Joi.object({
  txProposalId: Joi.string()
    .guid({
      version: [
        'uuidv4',
        'uuidv5',
      ],
    })
    .required(),
});

const bodySchema = Joi.object({
  txHex: Joi.string().alphanum(),
});

/*
 * Send a transaction.
 *
 * This lambda is called by API Gateway on PUT /txproposals/{proposalId}
 */
export const send: APIGatewayProxyHandler = middy(walletIdProxyHandler(async (walletId, event) => {
  const logger = createDefaultLogger();
  const requestContext = {
    walletId,
    requestId: event.requestContext?.requestId,
    operation: 'txProposalSend',
  };

  logger.info('Processing tx proposal send request', requestContext);

  if (!event.pathParameters) {
    logger.error('Missing txProposalId parameter', requestContext);
    return closeDbAndGetError(mysql, ApiError.MISSING_PARAMETER, { parameter: 'txProposalId' });
  }

  const { value, error } = paramsSchema.validate(event.pathParameters);

  if (error) {
    // There is only one parameter on this API (txProposalId) and it is on path 0
    const parameter = error.details[0].path[0];

    logger.error('Invalid txProposalId parameter', { ...requestContext, parameter, error: error.message });
    return closeDbAndGetError(mysql, ApiError.INVALID_PARAMETER, { parameter });
  }

  const { txProposalId } = value;
  // Add txProposalId to context for all subsequent logs
  const opContext = { ...requestContext, txProposalId };

  const bodyValidation = bodySchema.validate(JSON.parse(event.body));

  if (bodyValidation.error) {
    logger.error('Invalid request body', { ...opContext, error: bodyValidation.error.message });
    return closeDbAndGetError(mysql, ApiError.INVALID_PAYLOAD);
  }

  const { txHex } = bodyValidation.value;
  const txProposal = await getTxProposal(mysql, txProposalId);

  if (txProposal === null) {
    logger.error('Tx proposal not found', opContext);
    return closeDbAndGetError(mysql, ApiError.TX_PROPOSAL_NOT_FOUND);
  }

  if (txProposal.walletId !== walletId) {
    logger.error('Wallet mismatch - forbidden access', { ...opContext, expectedWallet: walletId, actualWallet: txProposal.walletId });
    return closeDbAndGetError(mysql, ApiError.FORBIDDEN);
  }

  // we can only send if it's still open or there was an error sending before
  if (txProposal.status !== TxProposalStatus.OPEN && txProposal.status !== TxProposalStatus.SEND_ERROR) {
    logger.error('Tx proposal not in sendable state', { ...opContext, status: txProposal.status });
    return closeDbAndGetError(mysql, ApiError.TX_PROPOSAL_NOT_OPEN, { status: txProposal.status });
  }

  const now = getUnixTimestamp();
  const txProposalInputs = await getTxProposalInputs(mysql, txProposalId);

  // WRAP in try-catch to prevent connection leaks on external API failures
  try {
    const tx = hathorLib.helpersUtils.createTxFromHex(txHex, new hathorLib.Network(config.network));

    if (tx.inputs.length !== txProposalInputs.length) {
      logger.error('Tx input count mismatch', { ...opContext, expectedInputs: txProposalInputs.length, actualInputs: tx.inputs.length });
      return closeDbAndGetError(mysql, ApiError.TX_PROPOSAL_NO_MATCH);
    }

    const txHexInputHashes = tx.inputs.map((input) => input.hash);

    for (let i = 0; i < txProposalInputs.length; i++) {
      // Validate that the inputs on the txHex are the same as those sent on txProposalCreate
      if (txHexInputHashes.indexOf(txProposalInputs[i].txId) < 0) {
        logger.error('Tx input hash mismatch', { ...opContext, missingTxId: txProposalInputs[i].txId });
        return closeDbAndGetError(mysql, ApiError.TX_PROPOSAL_NO_MATCH);
      }
    }

    logger.info('Pushing transaction to network', { ...opContext, txHex });

    const response: ApiResponse = await new Promise((resolve) => {
      hathorLib.txApi.pushTx(txHex, false, resolve);
    });

    if (!response.success) throw new Error(response.message);

    await updateTxProposal(
      mysql,
      [txProposalId],
      now,
      TxProposalStatus.SENT,
    );

    await closeDbConnection(mysql);

    logger.info('Tx proposal sent successfully', { ...opContext, txHex });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        txProposalId,
        txHex,
      }),
    };
  } catch (e) {
    // This catch is critical - prevents connection leak when pushTx fails
    logger.error('Failed to send tx proposal', { ...opContext, error: e.message, stack: e.stack });

    await updateTxProposal(
      mysql,
      [txProposalId],
      now,
      TxProposalStatus.SEND_ERROR,
    );

    await releaseTxProposalUtxos(mysql, [txProposalId]);

    return closeDbAndGetError(mysql, ApiError.TX_PROPOSAL_SEND_ERROR, {
      message: e.message,
      txProposalId,
      txHex,
    });
  }
})).use(cors())
  .use(errorHandler());
