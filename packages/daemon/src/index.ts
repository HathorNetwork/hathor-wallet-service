/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { interpret } from 'xstate';
import { SyncMachine } from './machines';
import logger from './logger';
import { checkEnvVariables } from './config';
import { bigIntUtils } from '@hathor/wallet-lib';

const main = async () => {
  checkEnvVariables();
  // Interpret the machine (start it and listen to its state changes)
  const machine = interpret(SyncMachine);

  machine.onTransition((state) => {
    logger.info(`Transitioned to ${bigIntUtils.JSONBigInt.stringify(state.value)}`);
  });

  machine.onEvent((event) => {
    logger.info(`Processing event: ${bigIntUtils.JSONBigInt.stringify(event.type)}`);
  });

  machine.start();
};

main();
