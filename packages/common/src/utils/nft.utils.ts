/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { LambdaClient, InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { addAlert } from './alerting.utils';
import { Severity } from '../types';
import { Network, constants, CreateTokenTransaction, helpersUtils } from '@hathor/wallet-lib';
// FIXME: import from lib path on HathorLib
import type { HistoryTransaction } from '@hathor/wallet-lib/lib/models/types';
import { Logger } from 'winston';
import { FullNodeTransaction, FullNodeInput, FullNodeOutput } from '../types';

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
  static async invokeNftHandlerLambda(txId: string, stage: string, deployPrefix: string, logger: Logger): Promise<void> {
    // Check for required environment variables
    if (!process.env.WALLET_SERVICE_LAMBDA_ENDPOINT || !process.env.AWS_REGION) {
      throw new Error('Environment variables WALLET_SERVICE_LAMBDA_ENDPOINT and AWS_REGION are not set.');
    }

    // Skip if NFT auto review is disabled
    if (!isNftAutoReviewEnabled()) {
      logger.debug('NFT auto review is disabled. Skipping lambda invocation.');
      return;
    }

    const client = new LambdaClient({
      endpoint: process.env.WALLET_SERVICE_LAMBDA_ENDPOINT,
      region: process.env.AWS_REGION,
    });
    // invoke lambda asynchronously to metadata update
    const command = new InvokeCommand({
      FunctionName: `${deployPrefix}-${stage}-onNewNftEvent`,
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
   * Process a new NFT event by transforming the data, checking if it should invoke the NFT handler,
   * and invoking the lambda if appropriate.
   */
  static async processNftEvent(
    eventData: FullNodeTransaction,
    stage: string,
    deployPrefix: string,
    network: Network,
    logger: Logger
  ): Promise<boolean> {
    // Early return if NFT auto review is disabled
    if (!isNftAutoReviewEnabled()) {
      logger.debug('NFT auto review is disabled. Skipping NFT handler invocation.');
      return false;
    }

    // Early return if not a token creation transaction
    if (eventData.version !== constants.CREATE_TOKEN_TX_VERSION) {
      logger.debug(`Transaction version ${eventData.version} is not a token creation transaction (${constants.CREATE_TOKEN_TX_VERSION}). Skipping NFT handler invocation.`);
      return false;
    }

    try {
      // Transform the data to a format compatible with shouldInvokeNftHandlerForTx
      const transformedTx = NftUtils.transformFullNodeTxForNftDetection(eventData);

      // Check if we should invoke the NFT handler for this transaction
      if (NftUtils.shouldInvokeNftHandlerForTx(transformedTx, network, logger)) {
        // Get the transaction hash
        const txId = eventData.hash;

        // Invoke the lambda function
        await NftUtils.invokeNftHandlerLambda(txId, stage, deployPrefix, logger);
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`Error processing NFT event: ${error}`);
      return false;
    }
  }

  /**
   * Transform transaction data from the full node to a format compatible with the NFT detection logic.
   */
  static transformFullNodeTxForNftDetection(fullNodeData: FullNodeTransaction): HistoryTransaction {
    // Create a new object with the required properties
    let transformedTx: HistoryTransaction = {
      tx_id: fullNodeData.hash, // Add tx_id for compatibility
      version: fullNodeData.version,
      tokens: fullNodeData.tokens,
      inputs: fullNodeData.inputs.map((input: FullNodeInput) => {
        // Extract the token index from token_data using hathor's TOKEN_INDEX_MASK
        // The token_data field contains both the token index and other flags
        // TOKEN_INDEX_MASK is used to isolate just the token index bits
        // We subtract 1 because token indexes are 1-based in token_data but 0-based in the tokens array
        const tokenIndex = (input.spent_output.token_data & constants.TOKEN_INDEX_MASK) - 1;

        return {
          tx_id: input.tx_id,
          index: input.index,
          token: tokenIndex < 0 ? constants.NATIVE_TOKEN_UID : fullNodeData.tokens[tokenIndex],
          token_data: input.spent_output.token_data,
          value: input.spent_output.value,
          script: input.spent_output.script,
          decoded: input.spent_output.decoded || {},
        };
      }),
      outputs: fullNodeData.outputs.map((output: FullNodeOutput) => {
        // Extract the token index from token_data using the same bit masking technique
        // A negative result means it's the HTR token (index < 0)
        // A positive result is an index into the tokens array (custom tokens)
        const tokenIndex = (output.token_data & constants.TOKEN_INDEX_MASK) - 1;

        return {
          value: output.value,
          token_data: output.token_data,
          script: output.script,
          token: tokenIndex < 0 ? constants.NATIVE_TOKEN_UID : fullNodeData.tokens[tokenIndex],
          decoded: output.decoded || {},
          spent_by: null,
        };
      }),
      signalBits: fullNodeData.signal_bits,
      weight: fullNodeData.weight,
      timestamp: fullNodeData.timestamp,
      is_voided: !!fullNodeData.voided,
      // XXX: This may have conversion errors but the value is of no consequence
      nonce: Number(fullNodeData.nonce),
      parents: fullNodeData.parents ?? [],
    };

    if (fullNodeData.token_name && fullNodeData.token_symbol) {
      transformedTx.token_name = fullNodeData.token_name;
      transformedTx.token_symbol = fullNodeData.token_symbol;
    }

    return transformedTx;
  }
}
