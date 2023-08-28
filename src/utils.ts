/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import dotenv from 'dotenv';
import { isNumber, isEmpty } from 'lodash';
import {
  wallet,
  constants,
  Output,
  Network,
  scriptsUtils,
  P2PKH,
  P2SH,
  ScriptData,
  errors,
// @ts-ignore
} from '@hathor/wallet-lib';

import {
  Block,
  ApiResponse,
  FullBlock,
  Input,
  DecodedScript,
  FullTx,
  StatusEvent,
  MempoolEvent,
  PreparedTx,
  PreparedInput,
  PreparedOutput,
  PreparedDecodedScript,
  RawTxResponse,
  TxSendResult,
  RawTx,
  RawInput,
  RawOutput,
  Severity,
  TxOutput,
  TxOutputWithIndex,
  TxInput,
  EventTxInput,
  StringMap,
  TokenBalanceMap,
  DbTxOutput,
} from './types';
import {
  downloadTx,
  downloadMempool,
  getBlockByTxId,
  getFullNodeBestBlock,
  downloadBlockByHeight,
} from './api/fullnode';
import { getWalletServiceBestBlock, sendTx, addAlert } from './api/lambda';
import logger from './logger';

dotenv.config();

export const IGNORE_TXS: Map<string, string[]> = new Map<string, string[]>([
  [
    'mainnet',
    [
      '000006cb93385b8b87a545a1cbb6197e6caff600c12cc12fc54250d39c8088fc',
      '0002d4d2a15def7604688e1878ab681142a7b155cbe52a6b4e031250ae96db0a',
      '0002ad8d1519daaddc8e1a37b14aac0b045129c01832281fb1c02d873c7abbf9',
    ],
  ],
  [
    'testnet',
    [
      '0000033139d08176d1051fb3a272c3610457f0c7f686afbe0afe3d37f966db85',
      '00e161a6b0bee1781ea9300680913fb76fd0fac4acab527cd9626cc1514abdc9',
      '00975897028ceb037307327c953f5e7ad4d3f42402d71bd3d11ecb63ac39f01a',
    ],
  ],
]);

const TX_CACHE_SIZE: number =
  parseInt(process.env.TX_CACHE_SIZE as string) || 200;

function getAlertSeverityForReorgSize(reorg_size: number) {
  if (reorg_size < 3) return Severity.INFO;
  else if (reorg_size < 5) return Severity.WARNING;
  else if (reorg_size < 10) return Severity.MINOR;
  else if (reorg_size < 20) return Severity.MEDIUM;
  else if (reorg_size < 30) return Severity.MAJOR;
  else return Severity.CRITICAL;
}

/**
 * Download and parse a tx by it's id
 *
 * @param txId - the id of the tx to be downloaded
 */
export const downloadTxFromId = async (
  txId: string,
  noCache: boolean = false
): Promise<FullTx | null> => {
  const network: string = process.env.NETWORK || 'mainnet';

  // Do not download genesis transactions
  if (IGNORE_TXS.has(network)) {
    const networkTxs: string[] = IGNORE_TXS.get(network) as string[];

    if (networkTxs.includes(txId)) {
      // Skip
      return null;
    }
  }

  const txData: RawTxResponse = await downloadTx(txId, noCache);
  const { tx } = txData;

  return parseTx(tx);
};

/**
 * Recursively downloads all transactions confirmed directly or indirectly by a block
 *
 * This method will go through the parent tree and the inputs tree downloading all transactions,
 * while ignoring transactions confirmed by blocks with height < blockHeight
 *
 * NOTE: This operation will get slower and slower as the BFS dives into the funds and the confirmation DAGs 
 *
 * @param blockId - The blockId to download the transactions
 * @param blockHeight - The block height from the block we are downloading transactions from
 * @param txIds - List of transactions to download
 * @param data - Downloaded transactions, used while being called recursively
 */
export const recursivelyDownloadTx = async (
  blockId: string,
  blockHeight: number,
  txIds: string[] = [],
  data = new Map<string, FullTx>()
): Promise<Map<string, FullTx>> => {
  if (txIds.length === 0) {
    return data;
  }

  const txId: string = txIds.pop() as string;
  const network: string = process.env.NETWORK || 'mainnet';

  if (IGNORE_TXS.has(network)) {
    const networkTxs: string[] = IGNORE_TXS.get(network) as string[];

    if (networkTxs.includes(txId)) {
      // Skip
      return recursivelyDownloadTx(blockId, blockHeight, txIds, data);
    }
  }

  const txData: RawTxResponse = await downloadTx(txId);
  const { tx, meta } = txData;
  const parsedTx: FullTx = parseTx(tx);

  if (parsedTx.parents.length > 2) {
    // We downloaded a block, we should ignore it
    return recursivelyDownloadTx(blockId, blockHeight, txIds, data);
  }

  // Transaction was already confirmed by a different block
  if (meta.first_block && meta.first_block !== blockId) {
    let firstBlockHeight = meta.first_block_height;

    // This should never happen
    // Using == to include `undefined` on this check
    if (firstBlockHeight == null) {
      throw new Error('Transaction was confirmed by a block but we were unable to detect its height');
    }

    // If the transaction was confirmed by an older block, ignore it as it was
    // already sent to the wallet-service
    if (firstBlockHeight < blockHeight) {
      return recursivelyDownloadTx(blockId, blockHeight, txIds, data);
    }
  }

  const inputList = parsedTx.inputs.map((input) => input.txId);
  const txList = [...parsedTx.parents, ...inputList];
  const txIdsSet = new Set(txIds);

  // check if we have already downloaded any of the transactions of the new list
  const newTxIds = txList.filter(transaction => {
    return (
      !txIdsSet.has(transaction) &&
      /* Removing the current tx from the list of transactions to download: */
      transaction !== txId &&
      /* Data works as our return list on the recursion and also as a "seen" list on the BFS.
       * We don't want to download a transaction that is already on our seen list. */
      !data.has(transaction)
    );
  });

  const newData = data.set(parsedTx.txId, {
    ...parsedTx,
    voided: (meta.voided_by && meta.voided_by.length && meta.voided_by.length) > 0,
  });

  return recursivelyDownloadTx(blockId, blockHeight, [...txIds, ...newTxIds], newData);
};

/**
 * Prepares a transaction to be sent to the wallet-service `onNewTxRequest`
 *
 * @param tx - `FullTx` or `FullBlock` representing a typed transaction to be prepared
 */
export const prepareTx = (tx: FullTx | FullBlock): PreparedTx => {
  const prepared = {
    tx_id: tx.txId,
    nonce: tx.nonce,
    timestamp: tx.timestamp,
    version: tx.version,
    weight: tx.weight,
    parents: tx.parents,
    token_name: tx.tokenName,
    token_symbol: tx.tokenSymbol,
    height: tx.height,
    inputs: tx.inputs.map(input => {
      const baseInput: PreparedInput = {
        tx_id: input.txId,
        value: input.value,
        token_data: input.tokenData,
        script: input.script,
        decoded: input.decoded as PreparedDecodedScript,
        index: input.index,
        token: '',
      };

      if (input.tokenData === 0) {
        return {
          ...baseInput,
          token: '00',
        };
      }

      if (!tx.tokens || tx.tokens.length <= 0) {
        throw new Error(
          'Input is a token but there are no tokens in the tokens list.'
        );
      }

      const { uid } = tx.tokens[
        wallet.getTokenIndex(input.decoded.tokenData) - 1
      ];

      return {
        ...baseInput,
        token: uid,
      };
    }),
    outputs: tx.outputs.map(output => {
      const baseOutput: PreparedOutput = {
        value: output.value,
        token_data: output.tokenData,
        script: output.script,
        token: '',
        decoded: output.decoded as PreparedDecodedScript,
      };

      if (output.tokenData === 0) {
        return {
          ...baseOutput,
          token: '00',
        };
      }

      if (!tx.tokens || tx.tokens.length <= 0) {
        throw new Error(
          'Output is a token but there are no tokens in the tokens list.'
        );
      }

      if (!output.decoded || isEmpty(output.decoded) || !output.decoded.type) {
        return baseOutput;
      }

      const { uid } = tx.tokens[
        wallet.getTokenIndex(output.decoded.tokenData) - 1
      ];

      return {
        ...baseOutput,
        token: uid,
      };
    }),
    tokens: tx.tokens,
    raw: tx.raw,
  };

  return prepared;
};

/**
 * Types a tx that was received from the full_node
 *
 * @param tx - The transaction object as received by the full_node
 */
export const parseTx = (tx: RawTx): FullTx => {
  const parsedTx: FullTx = {
    txId: tx.hash as string,
    nonce: tx.nonce as string,
    version: tx.version as number,
    weight: tx.weight as number,
    timestamp: tx.timestamp as number,
    tokenName: tx.token_name ? (tx.token_name as string) : null,
    tokenSymbol: tx.token_symbol ? (tx.token_symbol as string) : null,
    inputs: tx.inputs.map((input: RawInput) => {
      const typedDecodedScript: DecodedScript = {
        type: input.decoded.type as string,
        address: input.decoded.address as string,
        timelock: isNumber(input.decoded.timelock)
          ? (input.decoded.timelock as number)
          : null,
        value: isNumber(input.decoded.value)
          ? (input.decoded.value as number)
          : null,
        tokenData: isNumber(input.decoded.token_data)
          ? (input.decoded.token_data as number)
          : null,
      };
      const typedInput: Input = {
        txId: input.tx_id as string,
        index: input.index as number,
        value: input.value as number,
        tokenData: input.token_data as number,
        script: input.script as string,
        decoded: typedDecodedScript,
      };

      return typedInput;
    }),
    outputs: tx.outputs.map(
      (output: RawOutput): Output => {
        const typedDecodedScript: DecodedScript = {
          type: output.decoded.type as string,
          address: output.decoded.address as string,
          timelock: isNumber(output.decoded.timelock)
            ? (output.decoded.timelock as number)
            : null,
          value: isNumber(output.decoded.value)
            ? (output.decoded.value as number)
            : null,
          tokenData: isNumber(output.decoded.token_data)
            ? (output.decoded.token_data as number)
            : null,
        };

        const typedOutput: Output = {
          value: output.value as number,
          tokenData: output.token_data as number,
          script: output.script as string,
          decoded: typedDecodedScript,
        };

        return typedOutput;
      }
    ),
    parents: tx.parents,
    tokens: tx.tokens,
    raw: tx.raw as string,
  };

  return parsedTx;
};

/**
 * Syncs the latest mempool
 *
 * @generator
 * @yields {MempoolEvent}
 */
export async function* syncLatestMempool(): AsyncGenerator<MempoolEvent> {
  logger.info(`Downloading mempool.`);
  let mempoolResp;
  try {
    mempoolResp = await downloadMempool();
  } catch (e) {
    yield {
      success: false,
      type: 'error',
      message: 'Could not download from mempool api',
    };
    return;
  }

  for (let i = 0; i < mempoolResp.transactions.length; i++) {
    const tx = await downloadTxFromId(mempoolResp.transactions[i], true); // we don't want to cache mempool transactions

    if (tx === null) {
      addAlert(
        'Failure to download tx from mempool',
        `Failure to download transaction ${mempoolResp.transactions[i]} from mempool`,
        Severity.WARNING, // Transaction will be downloaded again when it's confirmed by a block
        {
          'MempoolLength': mempoolResp.transactions.length,
          'TxId': mempoolResp.transactions[i],
        },
      );
      yield {
        type: 'error',
        success: false,
        message: `Failure on transaction ${mempoolResp.transactions[i]} in mempool`,
      };
      return;
    }

    const preparedTx: PreparedTx = prepareTx(tx);
    const sendTxResponse: TxSendResult = await sendTxHandler(preparedTx);

    if (!sendTxResponse.success) {
      addAlert(
        'Failure to send mempool tx to the wallet service',
        `Failure to send transaction ${tx.txId} from mempool to the wallet service`,
        Severity.WARNING, // Transaction will be downloaded again when it's confirmed by a block
        {
          'MempoolLength': mempoolResp.transactions.length,
          'TxId': mempoolResp.transactions[i],
        },
      );

      yield {
        type: 'error',
        success: false,
        message: `Failure on transaction ${preparedTx.tx_id} in mempool: ${sendTxResponse.message}`,
      };
      return;
    }

    yield {
      type: 'tx_success',
      success: true,
      txId: preparedTx.tx_id,
    };
  }

  yield {
    success: true,
    type: 'finished',
  };
}

/**
 * Sends a transaction to the lambda and handle the response
 */
export async function sendTxHandler (
  preparedTx: PreparedTx,
): Promise<TxSendResult> {
  try {
    const sendTxResponse: ApiResponse = await sendTx(preparedTx);

    if (!sendTxResponse.success) {
      logger.error(sendTxResponse.message);
      return {
        success: false,
        message: sendTxResponse.message,
      };
    }

    return { success: true };
  } catch(e) {
    logger.error(e);
    return {
      success: false,
      message: e.message,
    };
  }
}

/**
 * Syncs to the latest block
 *
 * @generator
 * @yields {StatusEvent} A status event indicating if a block at a height was successfully sent, \
 * if an error ocurred or if a reorg ocurred.
 */
export async function* syncToLatestBlock(): AsyncGenerator<StatusEvent> {
  let ourBestBlock: Block | null = null;
  let fullNodeBestBlock: Block | null = null;

  try {
    ourBestBlock = await getWalletServiceBestBlock();
    fullNodeBestBlock = await getFullNodeBestBlock();

  } catch (e) {
    yield {
      type: 'error',
      success: false,
      message: 'Failure to reach the wallet-service or the fullnode',
    };

    return;
  }

  // Check if our best block is still in the fullnode's chain
  const ourBestBlockInFullNode = await getBlockByTxId(ourBestBlock.txId, true);

  if (!ourBestBlockInFullNode.success) {
    logger.warn(ourBestBlockInFullNode.message);

    yield {
      type: 'reorg',
      success: false,
      message: 'Best block not found in the full-node. Reorg?',
    };

    addAlert(
      `Potential re-org on ${process.env.NETWORK}`,
      `Best block not found in the full-node.`,
      Severity.INFO,
      {
        'Wallet Service best block': ourBestBlock.txId,
        'Fullnode best block': fullNodeBestBlock.txId,
      },
    );

    return;
  }

  const { meta } = ourBestBlockInFullNode;

  if (meta.voided_by && meta.voided_by.length && meta.voided_by.length > 0) {
    const reorgSize = fullNodeBestBlock.height - ourBestBlock.height;

    const severity = getAlertSeverityForReorgSize(reorgSize);

    addAlert(
      `Re-org on ${process.env.NETWORK}`,
      `The daemon's best block has been voided, handling re-org`,
      severity,
      {
        'Wallet Service best block': ourBestBlock.txId,
        'Fullnode best block': fullNodeBestBlock.txId,
        'Reorg size': reorgSize,
      },
    );

    yield {
      type: 'reorg',
      success: false,
      message: 'Our best block was voided, we should reorg.',
    };

    return;
  }

  if (ourBestBlock.height > meta.height) {
    addAlert(
      `Re-org on ${process.env.NETWORK}`,
      `The downloaded height (${ourBestBlock.height}) is higher than the wallet service height (${meta.height})`,
      Severity.INFO,
      {
        'Wallet Service best block': ourBestBlock.txId,
        'Fullnode best block': fullNodeBestBlock.txId,
      },
    );

    yield {
      type: 'reorg',
      success: false,
      message: `Our height is higher than the wallet-service\'s height, we should reorg.`,
    };

    return;
  }

  logger.info(
    `Downloading ${fullNodeBestBlock.height - ourBestBlock.height} blocks...`
  );
  let success = true;

  blockLoop: for (
    let i = ourBestBlock.height + 1;
    i <= fullNodeBestBlock.height;
    i++
  ) {
    const block: FullBlock = await downloadBlockByHeight(i);
    const preparedBlock: PreparedTx = prepareTx(block);

    // Ignore parents[0] because it is a block
    const blockTxs = [block.parents[1], block.parents[2]];

    // Download block transactions
    const txList: Map<string, FullTx> = await recursivelyDownloadTx(
      block.txId,
      block.height,
      blockTxs,
    );

    const txs: FullTx[] = Array.from(txList.values()).sort(
      (x, y) => x.timestamp - y.timestamp
    );

    // Exclude duplicates and voided transactions:
    const uniqueTxs: Record<string, FullTx> = txs.reduce(
      (acc: Record<string, FullTx>, tx: FullTx) => {
        if (tx.voided) {
          return acc;
        }

        if (tx.txId in acc) {
          return acc;
        }

        return {
          ...acc,
          [tx.txId]: tx,
        };
      },
      {}
    );

    for (const key of Object.keys(uniqueTxs)) {
      const preparedTx: PreparedTx = prepareTx({
        ...uniqueTxs[key],
        height: block.height, // this tx is confirmed by the current block on the loop, we must send its height
      });


      const sendTxResponse: TxSendResult = await sendTxHandler(preparedTx);

      if (!sendTxResponse.success) {
        addAlert(
          'Failed to send transaction',
          `Failure on transaction ${preparedTx.tx_id} from block: ${preparedBlock.tx_id}`,
          process.env.NETWORK === 'mainnet' ? Severity.CRITICAL : Severity.MAJOR,
        );

        yield {
          type: 'transaction_failure',
          success: false,
          message: `Failure on transaction ${preparedTx.tx_id} from block: ${preparedBlock.tx_id}`,
        };

        success = false;

        break blockLoop;
      }
    }

    // We will send the block only after all transactions were sent
    // to be sure that all downloads were succesfull since there is no
    // ROLLBACK yet on the wallet-service.
    const sendBlockResponse: TxSendResult = await sendTxHandler(preparedBlock);

    if (!sendBlockResponse.success) {
      addAlert(
        'Failed to send block transaction',
        `Failure on block ${preparedBlock.tx_id}`,
        process.env.NETWORK === 'mainnet' ? Severity.CRITICAL : Severity.MAJOR,
      );
      yield {
        type: 'error',
        success: false,
        message: `Failure on block ${preparedBlock.tx_id}`,
      };

      success = false;

      break;
    }

    yield {
      type: 'block_success',
      success: true,
      blockId: preparedBlock.tx_id,
      height: preparedBlock.height,
      transactions: Object.keys(uniqueTxs),
    };
  }

  yield {
    success,
    type: 'finished',
  };
}

// Map remembers the insertion order, so we can use it as a FIFO queue
export class LRU {
  max: number;
  cache: Map<string, any>;

  constructor(max: number = 10) {
    this.max = max;
    this.cache = new Map();
  }

  get(txId: string): any {
    const transaction = this.cache.get(txId);

    if (transaction) {
      this.cache.delete(txId);
      // Refresh it in the Map
      this.cache.set(txId, transaction);
    }

    return transaction;
  }

  set(txId: string, transaction: any): void {
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

  first(): string {
    return this.cache.keys().next().value;
  }

  clear(): void {
    this.cache = new Map();
  }
}

export const isAuthority = (tokenData: number): boolean => (
  (tokenData & constants.TOKEN_AUTHORITY_MASK) > 0    // eslint-disable-line no-bitwise
);


export const parseScript = (script: Buffer): P2PKH | P2SH | ScriptData | null => {
  const network = new Network(process.env.NETWORK);
  // It's still unsure how expensive it is to throw an exception in JavaScript. Some languages are really
  // inefficient when it comes to exceptions while others are totally efficient. If it is efficient,
  // we can keep throwing the error. Otherwise, we should just return null
  // because this method will be used together with others when we are trying to parse a given script.

  try {
    let parsedScript;
    if (P2PKH.identify(script)) {
      // This is a P2PKH script
      parsedScript = scriptsUtils.parseP2PKH(script, network);
    } else if (P2SH.identify(script)) {
      // This is a P2SH script
      parsedScript = scriptsUtils.parseP2SH(script, network);
    } else {
      // defaults to data script
      parsedScript = scriptsUtils.parseScriptData(script);
    }

    return parsedScript;
  } catch (error) {
    if (error instanceof errors.ParseError) {
      // We don't know how to parse this script
      return null;
    } else {
      throw error;
    }
  }
}

export const getTokenIndex = (tokenData: number): number => {
  return ((tokenData & constants.TOKEN_INDEX_MASK) - 1);
}

export const isTokenHTR = (tokenData: number): boolean => {
  return getTokenIndex(tokenData) === -1;
};

export const prepareInputs = (inputs: EventTxInput[], tokens: string[]): TxInput[] => {
  const preparedInputs: TxInput[] = inputs.reduce(
    (newInputs: TxInput[], _input: EventTxInput): TxInput[] => {
      const decoded = parseScript(Buffer.from(_input.script, 'base64'));
      const input: TxInput = {
        tx_id: _input.tx_id,
        index: _input.index,
        value: _input.value,
        token_data: _input.token_data,
        script: _input.script,
        token: (() => {
          if (!isTokenHTR(_input.token_data)) {
            return tokens[getTokenIndex(_input.token_data)];
          }

          return '00';
        })(),
        decoded: (() => {
          if (decoded) {
            return {
              type: decoded.getType(),
              address: decoded.address?.base58,
              timelock: decoded.timelock,
            };
          }

          return null;
        })(),
      };


      return [...newInputs, input];
    }, []);

  return preparedInputs;
};

export const prepareOutputs = (outputs: TxOutput[], tokens: string[]): TxOutputWithIndex[] => {
  const preparedOutputs: [number, TxOutputWithIndex[]] = outputs.reduce(
    ([currIndex, newOutputs]: [number, TxOutputWithIndex[]], _output: TxOutput): [number, TxOutputWithIndex[]] => {
      const output = new Output(_output.value, Buffer.from(_output.script, 'base64'));
      let token = '00';
      if (!output.isTokenHTR()) {
        token = tokens[output.getTokenIndex()];
      }
      output.token = token;

      const network = new Network(process.env.NETWORK);
      const decoded = output.parseScript(network);

      if (decoded) {
        output.decoded = {
          type: decoded.getType(),
          address: decoded.address?.base58,
          timelock: decoded.timelock,
        };
      }

      if (!output.decoded
          || output.decoded.type === null
          || output.decoded.type === undefined) {
        return [currIndex + 1, newOutputs];
      }

      output.locked = false;

      return [
        currIndex + 1,
        [
          ...newOutputs,
          {
            ...output,
            index: currIndex,
          },
        ],
      ];
    },
    [0, []],
  );

  return preparedOutputs[1];
};

/**
 * Get the map of token balances for each address in the transaction inputs and outputs.
 *
 * @example
 * Return map has this format:
 * ```
 * {
 *   address1: {token1: balance1, token2: balance2},
 *   address2: {token1: balance3}
 * }
 * ```
 *
 * @param inputs - The transaction inputs
 * @param outputs - The transaction outputs
 * @returns A map of addresses and its token balances
 */
export const getAddressBalanceMap = (
  inputs: DbTxOutput[],
  outputs: TxOutput[],
): StringMap<TokenBalanceMap> => {
  const addressBalanceMap = {};

  for (const input of inputs) {
    const address = input.address;

    // get the TokenBalanceMap from this input
    const tokenBalanceMap = TokenBalanceMap.fromTxInput(input);
    // merge it with existing TokenBalanceMap for the address
    // @ts-ignore
    addressBalanceMap[address] = TokenBalanceMap.merge(addressBalanceMap[address], tokenBalanceMap);
  }

  for (const output of outputs) {
    if (!output.decoded) {
      throw new Error('Outputhas no decoded script');
    }

    if (!output.decoded.address) {
      throw new Error('Decoded output data has no address');
    }
    const address = output.decoded.address;

    // get the TokenBalanceMap from this output
    const tokenBalanceMap = TokenBalanceMap.fromTxOutput(output);

    // merge it with existing TokenBalanceMap for the address
    // @ts-ignore
    addressBalanceMap[address] = TokenBalanceMap.merge(addressBalanceMap[address], tokenBalanceMap);
  }

  return addressBalanceMap;
};

export const globalCache = new LRU(TX_CACHE_SIZE);
