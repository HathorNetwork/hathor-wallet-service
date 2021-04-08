import {
  Machine,
  assign,
  send,
} from 'xstate';
import { syncToLatestBlock } from './utils';
import {
  SyncSchema,
  SyncContext,
  // SyncEvent,
} from './types';

export const syncHandler = (_context, _event) => (callback, onReceive) => {
  console.log('Sync handler instantiated');
  const iterator = syncToLatestBlock();
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

      if (value.type === 'reorg') {
        console.log(value.message);
        callback('REORG');
        return;
      }

      if (value.type === 'finished') {
        console.log('FINISHED!');
        callback('DONE');
      }

      console.log('Downloaded block: ', value);
    }

    return;
  };


  onReceive((e) => {
    if (e.type === 'START') {
      asyncCall();
    }
  });

  return () => {
    console.log('Stopping the iterator.');
    iterator.return('finished');

    return;
  };
};

// TODO: We need to type the Event
export const SyncMachine = Machine<SyncContext, SyncSchema, any>({
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
  },
  actions: {
    resetMoreBlocks: assign({
      hasMoreBlocks: () => false,
    }),
    setMoreBlocks: assign({
      hasMoreBlocks: () => true,
    }),
  },
  services: {
    syncHandler,
  },
});
