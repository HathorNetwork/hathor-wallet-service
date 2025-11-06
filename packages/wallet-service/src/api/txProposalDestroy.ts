import { APIGatewayProxyHandler } from 'aws-lambda';

import 'source-map-support/register';

import { ApiError } from '@src/api/errors';
import {
  getTxProposal,
  updateTxProposal,
  releaseTxProposalUtxos,
} from '@src/db';
import { walletIdProxyHandler } from '@src/commons';
import { TxProposalStatus } from '@src/types';
import { closeDbConnection, getDbConnection, getUnixTimestamp } from '@src/utils';
import { closeDbAndGetError } from '@src/api/utils';
import middy from '@middy/core';
import cors from '@middy/http-cors';
import errorHandler from '@src/api/middlewares/errorHandler';
import createDefaultLogger from '@src/logger';

const mysql = getDbConnection();

/*
 * Destroy a txProposal.
 *
 * This lambda is called by API Gateway on DELETE /txproposals/{proposalId}
 */
export const destroy: APIGatewayProxyHandler = middy(walletIdProxyHandler(async (walletId, event) => {
  const logger = createDefaultLogger();
  const requestContext = {
    walletId,
    requestId: event.requestContext?.requestId,
    operation: 'txProposalDestroy',
  };

  logger.info('Processing tx proposal destruction request', requestContext);

  const params = event.pathParameters;
  let txProposalId: string;

  if (params && params.txProposalId) {
    txProposalId = params.txProposalId;
  } else {
    logger.error('Missing txProposalId parameter', requestContext);
    return closeDbAndGetError(mysql, ApiError.MISSING_PARAMETER, { parameter: 'txProposalId' });
  }

  const opContext = { ...requestContext, txProposalId };

  const txProposal = await getTxProposal(mysql, txProposalId);

  if (txProposal === null) {
    logger.error('Tx proposal not found', opContext);
    return closeDbAndGetError(mysql, ApiError.TX_PROPOSAL_NOT_FOUND);
  }

  if (txProposal.walletId !== walletId) {
    logger.error('Wallet mismatch - forbidden access', { ...opContext, expectedWallet: walletId, actualWallet: txProposal.walletId });
    return closeDbAndGetError(mysql, ApiError.FORBIDDEN);
  }

  if (txProposal.status !== TxProposalStatus.OPEN && txProposal.status !== TxProposalStatus.SEND_ERROR) {
    logger.error('Tx proposal not in destroyable state', { ...opContext, status: txProposal.status });
    return closeDbAndGetError(mysql, ApiError.TX_PROPOSAL_NOT_OPEN);
  }

  const now = getUnixTimestamp();

  logger.info('Destroying tx proposal', opContext);

  await updateTxProposal(
    mysql,
    [txProposalId],
    now,
    TxProposalStatus.CANCELLED,
  );

  // Remove tx_proposal_id and tx_proposal_index from utxo table
  await releaseTxProposalUtxos(mysql, [txProposalId]);

  await closeDbConnection(mysql);

  logger.info('Tx proposal destroyed successfully', opContext);

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      txProposalId,
    }),
  };
})).use(cors())
  .use(errorHandler());
