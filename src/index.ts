/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { interpret } from 'xstate';
import { SyncMachine, MempoolMachine } from './machine';
// @ts-ignore
import { Connection } from '@hathor/wallet-lib';

import logger from './logger';

// @ts-ignore
const machine = interpret(SyncMachine).onTransition(state => {
  console.log(`Sync on state: ${state.value}`);
});
// @ts-ignore
const mempMachine = interpret(MempoolMachine).onTransition(state => {
  console.log(`Mempool on state: ${state.value}`);
});;

const handleMessage = (message: any) => {
  switch(message.type) {
    case 'dashboard:metrics':
      break;

    /* This message is only being used as a signal that a new block may have arrived
     * the sync mechanism will download all blocks from the current height until the
     * full node's best block height
     */
    case 'network:new_tx_accepted':
      if (message.is_voided) return;
      if (!message.is_block) {
        // identify the tx as a mempool tx
        if (message.first_block) return;
        mempMachine.send({ type: 'MEMPOOL_UPDATE' });
        return;
      }
      machine.send({ type: 'NEW_BLOCK' });
      break;

    case 'state_update':
      /* This handles state updates from the websocket connection.
       * We will trigger a re-sync (by sending the NEW_BLOCK event) to
       * the machine, triggering a download if new blocks were generated.
       */
      if (message.state === Connection.CONNECTED) {
        mempMachine.send({ type: 'MEMPOOL_UPDATE' });
        machine.send({ type: 'NEW_BLOCK' });
      }
      break;
  }
};

mempMachine.start();
machine.start();

const DEFAULT_SERVER = process.env.DEFAULT_SERVER;
const conn = new Connection({ network: process.env.NETWORK, servers: [DEFAULT_SERVER] });

// @ts-ignore
conn.websocket.on('network', (message) => handleMessage(message));
// @ts-ignore
conn.on('state', (state) => handleMessage({
  type: 'state_update',
  state,
}));
conn.start();
