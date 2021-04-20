/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Block,
  ApiResponse,
  FullBlock,
  Input,
  Output,
  DecodedScript,
  FullTx,
  Token,
  StatusEvent,
  PreparedTx,
  PreparedInput,
  PreparedOutput,
} from './types';
import AWS from 'aws-sdk';
import axios from 'axios';
import dotenv from 'dotenv';
import { constants } from '@hathor/wallet-lib';

dotenv.config();

AWS.config.update({
  region: 'us-east-1',
});

const DEFAULT_SERVER = process.env.DEFAULT_SERVER || 'https://node1.foxtrot.testnet.hathor.network/v1a/';
const TOKEN_INDEX_MASK = constants.TOKEN_INDEX_MASK;
const TX_CACHE_SIZE: number = parseInt(process.env.TX_CACHE_SIZE) || 200;

/**
 * Calls a function from the wallet-service lambda
 *
 * @param fnName - The lambda function name
 * @param payload - The payload to be sent
 */
export const lambdaCall = (fnName: string, payload: any): Promise<any> => new Promise((resolve, reject) => {
  const lambda = new AWS.Lambda({
    apiVersion: '2015-03-31',
    endpoint: process.env.STAGE === 'local'
      ? process.env.WALLET_SERVICE_LOCAL_URL || 'http://localhost:3002'
      : `https://lambda.${process.env.AWS_REGION}.amazonaws.com`,
  });

      const params = {
        FunctionName: `${process.env.SERVICE_NAME}-${process.env.STAGE}-${fnName}`,
        Payload: JSON.stringify({
          body: payload,
        }),
      };

      lambda.invoke(params, (err, data) => {
        if (err) {
          console.log('err', err);
          reject(err);
        } else {
          if (data.StatusCode !== 200) {
            reject(new Error('Request failed.'));
          }

          try {
            const responsePayload = JSON.parse(data.Payload as string);
            const body = JSON.parse(responsePayload.body);

            resolve(body);
          } catch(e) {
            console.log('Erroed parsing response body: ', data.Payload);

            return reject(e.message);
          }
        }
      });
});

/**
 * Calls the onNewTxRequest lambda function with a PreparedTx
 *
 * @param tx - The prepared transaction to be sent
 */
export const sendTx = async (tx: PreparedTx): Promise<ApiResponse> => {
  const response = await lambdaCall('onNewTxRequest', tx);

  return response;
};

/**
 * Calls the getLatestBlock lambda function from the wallet-service returning
 * a typed `Block`.
 */
export const getWalletServiceBestBlock = async (): Promise<Block> => {
  const response = await lambdaCall('getLatestBlock', {});
  const bestBlock: Block = response.block;

  return bestBlock;
};

/**
 * Returns the best block from the full_node as a typed `Block`.
 * TODO FIXME: Change this method to query the best block from the `/v1a/get_block_template` or
 * a specialized API from the full_node to query its best block.
 */
export const getFullNodeBestBlock = async (): Promise<Block> => {
  const response = await axios.get(`${DEFAULT_SERVER}transaction?type=block&count=1`);
  const { transactions } = response.data;

  const bestBlock: Block = {
    txId: transactions[0].tx_id as string,
    height: transactions[0].height as number,
  };

  return bestBlock;
};

/**
 * Returns a transaction from the fullnode
 *
 * @param txId - The transaction id to be downloaded
 * @param noCache - Ignores cached transactions
 */
export const downloadTx = async (txId: string, noCache: boolean = false) => {
  if (!noCache && globalCache.get(txId)) {
    return globalCache.get(txId);
  }

  const response = await axios.get(`${DEFAULT_SERVER}transaction?id=${txId}`);

  if (!noCache) {
    globalCache.set(txId, response.data);
  }

  return response.data;
};

/**
 * Returns a `FullBlock` downloaded from the full_node
 *
 * @param height - The block's height
 */
export const downloadBlockByHeight = async (height: number): Promise<FullBlock> => {
  const response = await axios.get(`${DEFAULT_SERVER}block_at_height?height=${height}`);

  const data = response.data;

  if (!data.success) {
    throw new Error(`Block height ${height} download failed`);
  }

  const responseBlock = data.block;

  const block: FullBlock = {
    txId: responseBlock.tx_id as string,
    version: responseBlock.version as number,
    weight: responseBlock.weight as number,
    timestamp: responseBlock.timestamp as number,
    isVoided: responseBlock.is_voided as boolean,
    inputs: responseBlock.inputs.map((input) => {
      const typedDecodedScript: DecodedScript = {
        type: input.decoded.type as string,
        address: input.decoded.address as string,
        timelock: input.decoded.timelock ? input.decoded.timelock as number : null,
        value: input.decoded.value ? input.decoded.value as number : null,
        tokenData: input.decoded.token_data ? input.decoded.token_data as number : null,
      };
      const typedInput: Input = {
        txId: input.tx_id as string,
        index: input.index as number,
        value: input.value as number,
        tokenData: input.token_data as number,
        script: input.script as string,
        decoded: typedDecodedScript,
        token: input.token as string,
      };

      return typedInput;
    }),
    outputs: responseBlock.outputs.map((output): Output => {
      const typedDecodedScript: DecodedScript = {
        type: output.decoded.type as string,
        address: output.decoded.address as string,
        timelock: output.decoded.timelock ? output.decoded.timelock as number : null,
        value: output.decoded.value ? output.decoded.value as number : null,
        tokenData: output.decoded.token_data ? output.decoded.token_data as number : null,
      };

      const typedOutput: Output = {
        value: output.value as number,
        tokenData: output.token_data as number,
        script: output.script as string,
        decoded: typedDecodedScript,
        token: output.token as string,
        spentBy: output.spent_by ? output.spent_by as string : null,
      };

      return typedOutput;
    }),
    parents: responseBlock.parents,
    height: responseBlock.height as number,
  };

  return block;
};

/**
 * Recursively downloads all transactions that were confirmed by a given block
 *
 * @param blockId - The blockId to download the transactions
 * @param txIds - List of transactions to download
 * @param data - Downloaded transactions, used while being called recursively
 */
export const recursivelyDownloadTx = async (blockId: string, txIds: string[] = [], data: FullTx[] = []): Promise<FullTx[]> => {
  if (txIds.length === 0) {
    return data;
  }

  const txId = txIds.pop();
  const txData = await downloadTx(txId);
  const { tx, meta } = txData;
  const parsedTx: FullTx = parseTx(tx);

  if (parsedTx.parents.length > 2) {
    // We downloaded a block, we should ignore it
    return recursivelyDownloadTx(blockId, txIds, data);
  }

  // If the first_block from the downloaded tx is not from the block we are searching, we should ignore it.
  if (meta.first_block !== blockId) {
    return recursivelyDownloadTx(blockId, txIds, data);
  }

  // Ignore voided txs
  if (meta.voided_by && meta.voided_by.length && meta.voided_by.length > 0) {
    return recursivelyDownloadTx(blockId, txIds, data);
  }

  const newParents = parsedTx.parents.filter((parent) => txIds.indexOf(parent) < 0 && parent !== txId);

  return recursivelyDownloadTx(blockId, [...txIds, ...newParents], [...data, parsedTx]);
};

/**
 * Prepares a transaction to be sent to the wallet-service `onNewTxRequest`
 *
 * @param tx - `FullTx` or `FullBlock` representing a typed transaction to be prepared
 */
export const prepareTx = (tx: FullTx | FullBlock): PreparedTx => {
  const prepared = {
    ...tx,
    tx_id: tx.txId,
    raw: '',
    inputs: tx.inputs.map((input) => {
      const baseInput: PreparedInput = {
        value: input.value,
        token_data: input.tokenData,
        script: input.script,
        token: input.token,
        decoded: input.decoded,
        index: input.index,
      };

      if (input.tokenData === 0) {
        return {
          ...baseInput,
          token: '00',
        };
      }

      /* eslint-disable */
      const { uid } = tx.tokens[(input.tokenData & TOKEN_INDEX_MASK) - 1]; // eslint-disable-line no-bitwise
      /* eslint-enable */

      return {
        ...baseInput,
        token: uid,
      };
    }),
    outputs: tx.outputs.map((output) => {
      const baseOutput: PreparedOutput = {
        value: output.value,
        token_data: output.tokenData,
        script: output.script,
        token: output.token,
        spent_by: output.spentBy,
        decoded: output.decoded,
      };

      if (output.tokenData === 0) {
        return {
          ...baseOutput,
          token: '00',
        };
      }

      /* eslint-disable */
      const { uid } = tx.tokens[(output.tokenData & TOKEN_INDEX_MASK) - 1]; // eslint-disable-line no-bitwise
      /* eslint-enable */

      return {
        ...baseOutput,
        token: uid,
      };
    }),
  };

  return prepared;
};

/**
 * Types a tx that was received from the full_node
 *
 * @param tx - The transaction object as received by the full_node
 */
export const parseTx = (tx: any): FullTx => {
  const parsedTx: FullTx = {
    txId: tx.hash ? tx.hash as string : tx.tx_id as string,
    nonce: tx.nonce as string,
    version: tx.version as number,
    weight: tx.weight as number,
    timestamp: tx.timestamp as number,
    inputs: tx.inputs.map((input) => {
      const typedDecodedScript: DecodedScript = {
        type: input.decoded.type as string,
        address: input.decoded.address as string,
        timelock: input.decoded.timelock ? input.decoded.timelock as number : null,
        value: input.decoded.value ? input.decoded.value as number : null,
        tokenData: input.decoded.token_data ? input.decoded.token_data as number : null,
      };
      const typedInput: Input = {
        txId: input.tx_id as string,
        index: input.index as number,
        value: input.value as number,
        tokenData: input.token_data as number,
        script: input.script as string,
        decoded: typedDecodedScript,
        token: input.token as string,
      };

      return typedInput;
    }),
    outputs: tx.outputs.map((output): Output => {
      const typedDecodedScript: DecodedScript = {
        type: output.decoded.type as string,
        address: output.decoded.address as string,
        timelock: output.decoded.timelock ? output.decoded.timelock as number : null,
        value: output.decoded.value ? output.decoded.value as number : null,
        tokenData: output.decoded.token_data ? output.decoded.token_data as number : null,
      };

      const typedOutput: Output = {
        value: output.value as number,
        tokenData: output.token_data as number,
        script: output.script as string,
        decoded: typedDecodedScript,
        token: output.token as string,
        spentBy: output.spent_by ? output.spent_by as string : null,
      };

      return typedOutput;
    }),
    parents: tx.parents,
    tokens: tx.tokens.map((token: any): Token => {
      const parsedToken: Token = {
        uid: token.uid as string,
        name: token.name as string,
        symbol: token.symbol as string,
      };

      return parsedToken;
    }),
    raw: tx.raw as string,
  };

  return parsedTx;
};

/**
 * Downloads a block from the full_node using the `block_at_height` API
 *
 * @param txId - The block txId
 * @param noCache - Prevents downloading the block from cache as a reorg may have ocurred
 */
export const getBlockByTxId = async (txId: string, noCache: boolean = false) => {
  return downloadTx(txId, noCache);
};

/**
 * Syncs to the latest block
 *
 * @generator
 * @yields {StatusEvent} A status event indicating if a block at a height was successfully sent, \
 * if an error ocurred or if a reorg ocurred.
 */
export async function* syncToLatestBlock(): AsyncGenerator<StatusEvent> {
  const ourBestBlock: Block = await getWalletServiceBestBlock();
  const fullNodeBestBlock: Block = await getFullNodeBestBlock();

  // Check if our best block is still in the fullnode's chain
  const ourBestBlockInFullNode = await getBlockByTxId(ourBestBlock.txId, true);

  if (!ourBestBlockInFullNode.success) {
    yield {
      type: 'error',
      success: false,
      message: 'Could not validate our best block',
      error: ourBestBlockInFullNode.message,
    };

    return;
  }

  const { meta } = ourBestBlockInFullNode;

  if ((meta.voided_by &&
       meta.voided_by.length &&
         meta.voided_by.length > 0)) {
    yield {
      type: 'reorg',
      success: false,
      message: 'Our best block was voided, we should reorg.',
    };

    return;
  }

  if (ourBestBlock.height > meta.height) {
    yield {
      type: 'reorg',
      success: false,
      message: 'Our height is higher than the wallet-service\'s height, we should reorg.',
    };

    return;
  }

  console.log('Best block is valid.');
  let success = true;

  blockLoop:
    for (let i = ourBestBlock.height + 1; i <= fullNodeBestBlock.height; i++) {
    const block: FullBlock = await downloadBlockByHeight(i);
    const preparedBlock: PreparedTx = prepareTx(block);

    // Ignore parents[0] because it is a block
    const blockTxs = [
      block.parents[1],
      block.parents[2],
    ];

    // Download block transactions
    const txs: FullTx[] = await recursivelyDownloadTx(block.txId, blockTxs);

    // We will send the block only after all transactions were downloaded
    // to be sure that all downloads were succesfull since there is no
    // ROLLBACK yet on the wallet-service.
    const sendBlockResponse: ApiResponse = await sendTx(preparedBlock);

    if (!sendBlockResponse.success) {
      console.log(sendBlockResponse);
      yield {
        type: 'error',
        success: false,
        message: `Failure on block ${preparedBlock.tx_id}`,
      };

      success = false;

      break;
    }

    // Exclude duplicates:
    const uniqueTxs: FullTx[] = txs.reduce((acc: FullTx[], tx: FullTx): FullTx[] => {
      const alreadyInAcc = acc.find((accTx) => accTx.txId === tx.txId);

      if (alreadyInAcc) return acc;

      return [...acc, tx];
    }, []);

    txLoop:
      for (let i = 0; i < uniqueTxs.length; i++) {
      const preparedTx: PreparedTx = prepareTx(uniqueTxs[i]);

      try {
        const sendTxResponse: ApiResponse = await sendTx(preparedTx);

        if (!sendTxResponse.success) {
          throw new Error(sendTxResponse.message);
        }
      } catch (e) {
        yield {
          type: 'transaction_failure',
          success: false,
          message: `Failure on transaction ${preparedTx.tx_id} from block: ${preparedBlock.tx_id}`,
        };

        success = false;

        break blockLoop;
      }
    }

    yield {
      type: 'block_success',
      success: true,
      blockId: preparedBlock.tx_id,
      height: preparedBlock.height,
      transactions: uniqueTxs.map((tx: FullTx) => {
        return tx.txId;
      }),
    };
  }

  yield {
    success,
    type: 'finished',
  };
}

export class LRU {
  max: number;
  cache: Map<string, any>;

  constructor(max: number = 10) {
    this.max = max;
    this.cache = new Map();
  }

  get (txId: string) {
    const transaction = this.cache.get(txId);

    if (transaction) {
      this.cache.delete(txId);
      // Refresh it in the Map
      this.cache.set(txId, transaction);
    }

    return transaction;
  }

  set (txId, transaction) {
    if (this.cache.has(txId)) {
      // Refresh it in the map
      this.cache.delete(txId);
    }

    // Remove oldest
    if (this.cache.size === this.max) {
      this.cache.delete(this.first());
    }

    this.cache.set(txId, transaction);
  }

  first () {
    return this.cache.keys().next().value;
  }
}

export const globalCache = new LRU(TX_CACHE_SIZE);
