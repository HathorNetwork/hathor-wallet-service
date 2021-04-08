/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { interpret } from 'xstate';
import { SyncMachine } from './machine';
import { Connection } from '@hathor/wallet-lib';

const DEFAULT_SERVER = process.env.DEFAULT_SERVER;

const machine = interpret(SyncMachine).start();

machine.onTransition(state => {
  if (state.changed) {
    console.log('Transitioned to state: ', state.value);
  }
});

const handleMessage = (message: any) => {
  switch(message.type) {
    case 'dashboard:metrics':
      break;
    case 'network:new_tx_accepted':
      if (!message.is_block) return;
      if (message.is_voided) return;
      if (message.type === 'network:new_tx_accepted') {
        machine.send({ type: 'NEW_BLOCK' });
      }
      break;
    case 'state_update':
      if (message.state === Connection.CONNECTED) {
        machine.send({ type: 'NEW_BLOCK' });
      }
    break;
  }
};

const conn = new Connection({ network: 'testnet', servers: [DEFAULT_SERVER] });
conn.websocket.on('network', (message) => handleMessage(message));
conn.on('state', (state) => handleMessage({
  type: 'state_update',
  state,
}));
conn.start();
