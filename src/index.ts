/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { interpret } from 'xstate';
// import WebsocketMachine from './machine';
import { SyncMachine } from './machines';

const main = async () => {
  // Interpret the machine (start it and listen to its state changes)
  const machine = interpret(SyncMachine);

  machine.onTransition(state => {
    // You can handle side-effects or logging here if needed
    console.log('Transitioned to state:', state.value);
  }).start();
};

main();
