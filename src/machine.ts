/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Machine,
  assign,
  send,
} from 'xstate';
import { syncToLatestBlock, syncLatestMempool } from './utils';
import {
  GeneratorYieldResult,
  HandlerEvent,
  StatusEvent,
  MempoolEvent,
  SyncContext,
  SyncSchema,
} from './types';
import logger from './logger';

// @ts-ignore
export const syncHandler = () => (callback, onReceive) => {
  logger.debug('Sync handler instantiated');
  const iterator = syncToLatestBlock();
  const asyncCall: () => void = async () => {
    for (;;) {
      const block: GeneratorYieldResult<StatusEvent> = await iterator.next();
      const { value, done } = block;

      if (done) {
        // The generator reached its end, we should end this handler
        logger.debug('Done.', value)
        break;
      }

      if (value && !value.success) {
        logger.error(value.message);
        callback('ERROR');
        return;
      }

      if (value.type === 'reorg') {
        logger.info('A reorg happened: ', value.message);
        callback('REORG');
        return;
      } else if (value.type === 'finished') {
        logger.info('Sync generator finished.');
        callback('DONE');
      } else if (value.type === 'block_success') {
        logger.info(`Block id: ${value.blockId} sent successfully, transactions sent: ${value.transactions.length}`);
      } else {
        logger.warn(`Unhandled type received from sync generator: ${value.type}`);
      }
    }

    return;
  };

  /* onReceive is used for bi-directional communication between the
   * machine and the invoked service (syncHandler).
   *
   * For now, the only message we are handling is the start event, to indicate
   * that we should start the async promise dealing with the generator.
   */
  onReceive((e: HandlerEvent) => {
    if (e.type === 'START') {
      asyncCall();
    }
  });

  return () => {
    logger.debug('Stopping the iterator.');
    iterator.return('finished');

    return;
  };
};

// @ts-ignore
export const mempoolHandler = () => (callback, onReceive) => {
  logger.debug('Mempool handler instantiated');
  const iterator = syncLatestMempool();
  const asyncCall: () => void = async () => {
    for (;;) {
      const txResult: GeneratorYieldResult<MempoolEvent> = await iterator.next();
      const { value, done } = txResult;

      if (done) {
        // The generator reached its end, we should end this handler
        logger.debug('Done.', value)
        break;
      }

      if (value && !value.success) {
        logger.error(value.message);
        // if there is any error calling the lambda, wait 30 seconds and retry
        if (value.type == 'wait') {
          callback('WAIT');
          return;
        }
        callback('ERROR');
        return;
      }

      if (value.type === 'finished') {
        logger.info('Sync generator finished.');
        callback('DONE');
        return;
      } else if (value.type === 'tx_success') {
        logger.info('Mempool tx synced!');
      } else {
        logger.warn(`Unhandled type received from sync generator: ${value.type}`);
      }
    }

    return;
  };

  onReceive((e: HandlerEvent) => {
    switch(e.type) {
      case 'START':
        asyncCall();
        break
      case 'NEW_BLOCK':
        // stop iterator
        logger.debug('Stopping the iterator.');
        iterator.return('finished');
        break;
    }
  });

  return () => {
    logger.debug('Stopping the iterator.');
    iterator.return('finished');
  };
};

/* See README for an explanation on how the machine works.
 * TODO: We need to type the Event
 */
export const SyncMachine = Machine<SyncContext, SyncSchema>({
  id: 'sync',
  initial: 'idle',
  context: {
    hasMoreBlocks: false,
    hasMempoolUpdate: false,
  },
  states: {
    idle: {
      always: [
        { target: 'syncing', cond: 'hasMoreBlocks' },
        { target: 'mempoolsync', cond: 'hasMempoolUpdate' },
      ],
      on: {
        NEW_BLOCK: 'syncing',
        MEMPOOL_UPDATE: 'mempoolsync',
      },
    },
    mempoolsync: {
      invoke: {
        id: 'syncLatestMempool',
        src: 'mempoolHandler',
      },
      on: {
        MEMPOOL_UPDATE: {
          actions: ['setMempoolUpdate'],
        },
        STOP: 'idle',
        DONE: 'idle',
        ERROR: 'failure',
        WAIT: 'wait',
      },
      entry: [
        'resetMempoolUpdate',
        send('START', {
          to: 'syncLatestMempool',
        }),
      ],
    },
    syncing: {
      invoke: {
        id: 'syncToLatestBlock',
        src: 'syncHandler',
      },
      on: {
        NEW_BLOCK: {
          actions: ['setMoreBlocks'],
        },
        STOP: 'idle',
        DONE: 'idle',
        ERROR: 'failure',
        REORG: 'reorg',
      },
      entry: [
        'resetMoreBlocks',
        send('START', {
          to: 'syncToLatestBlock',
        }),
      ],
    },
    wait: {
      after: {
        30000: { target: 'idle' },
      },
    },
    reorg: {
      type: 'final',
    },
    failure: {
      type: 'final',
    },
  }
}, {
  guards: {
    hasMoreBlocks: (ctx) => ctx.hasMoreBlocks,
    hasMempoolUpdate: (ctx) => ctx.hasMempoolUpdate,
  },
  actions: {
    // @ts-ignore
    resetMoreBlocks: assign({
      hasMoreBlocks: () => false,
    }),
    // @ts-ignore
    setMoreBlocks: assign({
      hasMoreBlocks: () => true,
    }),
    // @ts-ignore
    resetMempoolUpdate: assign({
      hasMempoolUpdate: () => false,
    }),
    // @ts-ignore
    setMempoolUpdate: assign({
      hasMempoolUpdate: () => true,
    }),
  },
  services: {
    syncHandler,
    mempoolHandler,
  },
});
