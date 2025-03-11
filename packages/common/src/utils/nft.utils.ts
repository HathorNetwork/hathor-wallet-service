/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { LambdaClient, InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { addAlert } from './alerting.utils';
import { Severity } from '../types';
// @ts-ignore
import { Network, constants, CreateTokenTransaction, helpersUtils } from '@hathor/wallet-lib';
// @ts-ignore
import type { HistoryTransaction } from '@hathor/wallet-lib';
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
  static shouldInvokeNftHandlerForTx(tx: HistoryTransaction, network: Network, logger: Logger): boolean {
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
  static isTransactionNFTCreation(tx: HistoryTransaction, network: Network, logger: Logger): boolean {
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

  /**
   * Process an event from the full node and invoke the NFT handler lambda if needed.
   * @param eventData The full node event data
   * @param stage The deployment stage
   * @param network The network
   * @param logger The logger instance
   * @returns A promise that resolves when the processing is complete
   */
  static async processNftEvent(
    eventData: {
      hash: string;
      version: number;
      tokens: string[];
      token_name?: string | null;
      token_symbol?: string | null;
      inputs: Array<{
        tx_id: string;
        index: number;
        spent_output: {
          value: number;
          token_data: number;
          script: string;
          decoded?: {
            type: string;
            address: string;
            timelock: unknown;
          } | null;
        }
      }>;
      outputs: Array<{
        value: number;
        token_data: number;
        script: string;
        decoded?: {
          type: string;
          address: string;
          timelock: unknown;
        } | null;
      }>;
      [key: string]: unknown; // Allow other properties
    },
    stage: string,
    network: unknown,
    logger: Logger
  ): Promise<boolean> {
    if (!isNftAutoReviewEnabled()) {
      logger.debug('NFT auto review is disabled. Skipping NFT handler invocation.');
      return false;
    }

    // Transform the full node data to the format expected by the wallet library
    const txFromEvent = {
      ...eventData,
      tx_id: eventData.hash,
      inputs: eventData.inputs.map((input) => {
        const tokenIndex = (input.spent_output.token_data & constants.TOKEN_INDEX_MASK) - 1;

        return {
          token: tokenIndex < 0 ? constants.HATHOR_TOKEN_CONFIG.uid : eventData.tokens[tokenIndex],
          value: input.spent_output.value,
          token_data: input.spent_output.token_data,
          script: input.spent_output.script,
          decoded: {
            ...(input.spent_output.decoded || {}),
          },
          tx_id: input.tx_id,
          index: input.index
        };
      }),
      outputs: eventData.outputs.map((output) => {
        const tokenIndex = (output.token_data & constants.TOKEN_INDEX_MASK) - 1;
        return {
          ...output,
          decoded: output.decoded ? output.decoded : {},
          spent_by: null,
          token: tokenIndex < 0 ? constants.HATHOR_TOKEN_CONFIG.uid : eventData.tokens[tokenIndex],
        };
      }),
    };

    // Check if we should invoke the NFT handler for this transaction
    if (this.shouldInvokeNftHandlerForTx(txFromEvent, network, logger)) {
      try {
        // This process is not critical, so we run it but don't throw errors
        await this.invokeNftHandlerLambda(txFromEvent.tx_id, stage, logger);
        return true;
      } catch (err) {
        logger.error('[ALERT] Error on nftHandlerLambda invocation', err);
        return false;
      }
    }

    return false;
  }
}
