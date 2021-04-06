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
  send,
} from 'xstate';
import { syncToLatestBlockGen } from './utils';
import {
  SyncSchema,
  SyncContext,
  // SyncEvent,
} from './types';

const WEBSOCKET_SERVER = process.env.WEBSOCKET_SERVER;

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
      on: { NEW_BLOCK: 'syncing' },
    },
    syncing: {
      invoke: {
        id: 'syncToLatestBlock',
        src: (_context, _event) => (callback, onReceive) => {
          const iterator = syncToLatestBlockGen();
          const asyncCall: () => void = async () => {
            for (;;) {
              const block = await iterator.next();

              const { value, done } = block;
              if (done) {
                console.log('Done!', value)
                break;
              }

              if (value && !value.success) {
                console.log('Erroed!', value.message);
                callback('ERROR');
                return;
              }

              console.log('Downloaded block: ', value);
            }

            return;
          };

          asyncCall();

          onReceive((e) => {
            if (e.type === 'STOP') {
              console.log('Received STOP on onReceive.');
              // This will migrate to IDLE and STOP
              // the iterator
              callback('DONE');
            }
          });

          return () => {
            console.log('Stopping the iterator.');
            iterator.return();

            return;
          };
        },
      },
      on: {
        NEW_BLOCK: {
          actions: ['setMoreBlocks'],
        },
        STOP: {
          actions: send('STOP', {
            to: 'syncToLatestBlock',
          }),
        },
        DONE: 'idle',
        ERROR: 'failure',
      },
      entry: [
        'resetMoreBlocks',
        send('START', {
          to: 'syncToLatestBlock',
        }),
      ],
    },
    failure: {
      type: 'final',
    }
  }
}, {
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
    try {
      const message = JSON.parse(payload.utf8Data);

      switch(message.type) {
        case 'dashboard:metrics':
          break;
        case 'network:new_tx_accepted':
          if (!message.is_block) return;
          if (message.is_voided) return;

          machine.send({
            type: 'NEW_BLOCK',
            message,
          })
          break;
      }
    } catch(e) {
      console.log('E: ', e);
    }
  }
};

const client = new WebSocket.client();

client.on('connect', (connection) => {
  connection.on('message', (message) => handleMessage(message));
});

client.connect(WEBSOCKET_SERVER);
