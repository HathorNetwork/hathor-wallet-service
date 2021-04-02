/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// import { syncToLatestBlock } from './utils';
import WebSocket from 'websocket';
import {
  Machine,
  assign,
  interpret,
} from 'xstate';
import { syncToLatestBlockGen } from './utils';
import {
  SyncSchema,
  SyncContext,
  // SyncEvent,
} from './types';

const WEBSOCKET_SERVER = process.env.WEBSOCKET_SERVER;

const syncToLatestBlock = () => {
  console.log('Started the syncToLatestBlock activity.');
  const iterator = syncToLatestBlockGen();

  const asyncCall: () => void = async () => {
    for (;;) {
      const block = await iterator.next();
      if (block.done) {
        break;
      }

      console.log('Downloaded block: ', block.value);
    }

    return;
  };

  asyncCall();

  // This will stop the activity by force-return the iterator
  return () => {
    iterator.return();

    return;
  }
};

// TODO: We need to type the Event
export const syncMachine = Machine<SyncContext, SyncSchema, any>({
  id: 'sync',
  initial: 'idle',
  context: {
    hasMoreBlocks: false,
  },
  states: {
    idle: {
      always: [
        { target: 'syncing', cond: 'hasMoreBlocks' },
      ],
      on: {
        NEW_BLOCK: 'syncing'
      }
    },
    syncing: {
      entry: ['resetMoreBlocks'],
      activities: ['syncToLatestBlock'],
      on: {
        NEW_BLOCK: {
          actions: ['setMoreBlocks'],
          target: 'idle',
        },
        STOP: 'idle',
      }
    },
    failure: {
      type: 'final',
    }
  }
}, {
  activities: {
    syncToLatestBlock: () => syncToLatestBlock()
  },
  guards: {
    hasMoreBlocks: (ctx) => ctx.hasMoreBlocks,
  },
  actions: {
    resetMoreBlocks: assign({
      hasMoreBlocks: () => false,
    }),
    setMoreBlocks: assign({
      hasMoreBlocks: (ctx, event) => {
        const { message } = event;

        if (message.type === 'network:new_tx_accepted') {
          if (message.is_block) {
            console.log('Received new blocks, will set hasNewBlocks');
            return true;
          }
        }

        return ctx.hasMoreBlocks;
      }
    }),
  }
});

const machine = interpret(syncMachine).start();

machine.onTransition(state => {
  if (state.changed) {
    console.log('Transitioned to state: ', state.value);
  }
});

const handleMessage = (payload: any) => {
  if (payload.type === 'utf8') {
    const message = JSON.parse(payload.utf8Data);

    switch(message.type) {
      case 'dashboard:metrics':
        break;
      case 'network:new_tx_accepted':
        if (!message.is_block) return;
        if (message.is_voided) return;
        console.log('New block');
        machine.send({
          type: 'NEW_BLOCK',
          message,
        })
        break;
    }
  }
};

const client = new WebSocket.client();

client.on('connect', (connection) => {
  connection.on('message', (message) => handleMessage(message));
});

client.connect(WEBSOCKET_SERVER);
