/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { LambdaClient, InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { addAlert } from './alerting.utils';
import { Transaction, Severity } from '../types';
// @ts-ignore
import { Network, constants, CreateTokenTransaction, helpersUtils } from '@hathor/wallet-lib';
import { Logger } from 'winston';

/**
 * A helper for generating and updating a NFT Token's metadata.
 */

/** This env-var based feature toggle can be used to disable this feature */
export const isNftAutoReviewEnabled = (): boolean => process.env.NFT_AUTO_REVIEW_ENABLED === 'true';

export class NftUtils {
  /**
   * Returns whether we should invoke our NFT handler for this tx
   * @param tx - transaction to check
   * @param network - The current network
   * @param logger - A Logger instance
   * @returns - true if this is a NFT creation TX, false otherwise.
   *
   * TODO: Remove the logger param after we unify the logger from both projects
   */
  static shouldInvokeNftHandlerForTx(tx: Transaction, network: Network, logger: Logger): boolean {
    return isNftAutoReviewEnabled() && this.isTransactionNFTCreation(tx, network, logger);
  }

  /**
   * Returns if the transaction in the parameter is a NFT Creation.
   * @param {Transaction} tx
   * @returns {boolean}
   *
   * TODO: change tx type to HistoryTransaction
   * TODO: Remove the logger param after we unify the logger from both projects
   */
  static isTransactionNFTCreation(tx: any, network: Network, logger: Logger): boolean {
  /*
   * To fully check if a transaction is a NFT creation, we need to instantiate a new Transaction object in the lib.
   * So first we do some very fast checks to filter the bulk of the requests for NFTs with minimum processing.
   */
    if (
      tx.version !== constants.CREATE_TOKEN_TX_VERSION // Must be a token creation tx
    || !tx.token_name // Must have a token name
    || !tx.token_symbol // Must have a token symbol
    ) {
      return false;
    }

    // Continue with a deeper validation
    let isNftCreationTx: boolean;
    let libTx: CreateTokenTransaction;

    // Transaction parsing failures should be alerted
    try {
      libTx = helpersUtils.createTxFromHistoryObject(tx) as CreateTokenTransaction;
    } catch (ex) {
      logger.error('[ALERT] Error when parsing transaction on isTransactionNFTCreation', {
        transaction: tx,
        error: ex,
      });

      // isTransactionNFTCreation should never throw. We will just raise an alert and exit gracefully.
      return false;
    }

    // Validate the token: the validateNft will throw if the transaction is not a NFT Creation
    try {
      libTx.validateNft(network);
      isNftCreationTx = true;
    } catch (ex) {
      isNftCreationTx = false;
    }

    return isNftCreationTx;
  }

  /**
   * Calls the token metadata on the Explorer Service API to update a token's metadata
   * @param {string} nftUid
   * @param {Record<string, unknown>} metadata
   * TODO: Remove the logger param after we unify the logger from both projects
   */
  static async _updateMetadata(nftUid: string, metadata: Record<string, unknown>, maxRetries: number, logger: Logger): Promise<unknown> {
    const client = new LambdaClient({
      endpoint: process.env.EXPLORER_SERVICE_LAMBDA_ENDPOINT,
      region: process.env.AWS_REGION,
    });
   const command = new InvokeCommand({
      FunctionName: `hathor-explorer-service-${process.env.EXPLORER_SERVICE_STAGE}-create_or_update_dag_metadata`,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        id: nftUid,
        metadata,
      }),
    });

    let retryCount = 0;
    while (retryCount < maxRetries) {
      // invoke lambda asynchronously to metadata update
      const response: InvokeCommandOutput = await client.send(command);
      // Event InvocationType returns 202 for a successful invokation
      if (response.StatusCode === 202) {
        // End the loop successfully
        return response;
      }

      logger.warn('Failed metadata update', {
        nftUid,
        retryCount,
        statusCode: response.StatusCode,
        message: response.Payload?.toString(),
      });
      ++retryCount;
    }

    // Exceeded retry limit
    throw new Error(`Metadata update failed for tx_id: ${nftUid}.`);
  }

  /**
   * Identifies if the metadata for a NFT needs updating and, if it does, update it.
   * @param nftUid - The uid of the nft to create or update
   * @param maxRetries - The maximum number of retries
   * @param logger - A Logger instance
   *
   * @returns No data is returned after a successful update or skip
   * TODO: Remove the logger param after we unify the logger from both projects
   */
  static async createOrUpdateNftMetadata(nftUid: string, maxRetries: number, logger: Logger): Promise<void> {
    // The explorer service automatically merges the metadata content if it already exists.
    const newMetadata = {
      id: nftUid,
      nft: true,
    };
    await NftUtils._updateMetadata(nftUid, newMetadata, maxRetries, logger);
  }

  /**
   * Invokes this application's own intermediary lambda `onNewNftEvent`.
   * This is to improve the failure tolerance on this non-critical step of the sync loop.
   */
  static async invokeNftHandlerLambda(txId: string, stage: string, logger: Logger): Promise<void> {
    const client = new LambdaClient({
      endpoint: process.env.WALLET_SERVICE_LAMBDA_ENDPOINT,
      region: process.env.AWS_REGION,
    });
    // invoke lambda asynchronously to metadata update
   const command = new InvokeCommand({
      FunctionName: `hathor-wallet-service-${stage}-onNewNftEvent`,
      InvocationType: 'Event',
      Payload: JSON.stringify({ nftUid: txId }),
    });

    const response: InvokeCommandOutput = await client.send(command);

    // Event InvocationType returns 202 for a successful invokation
    if (response.StatusCode !== 202) {
      addAlert(
        'Error on NFTHandler lambda',
        'Erroed on invokeNftHandlerLambda invocation',
        Severity.MINOR,
        { TxId: txId },
        logger,
      );
      throw new Error(`onNewNftEvent lambda invoke failed for tx: ${txId}`);
    }
  }
}
