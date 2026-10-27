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
import { registerShieldedCryptoProvider } from './shieldedCrypto';

export const main = async (): Promise<void> => {
  checkEnvVariables();
  // Before the first event, so no vertex is ingested without a provider that
  // could have had one.
  await registerShieldedCryptoProvider();
  // Interpret the machine (start it and listen to its state changes)
  const machine = interpret(SyncMachine);

  machine.onTransition((state) => {
    const stateValue = bigIntUtils.JSONBigInt.stringify(state.value);
    logger.info(`Transitioned to ${stateValue}`);
  });

  machine.onDone(() => {
    logger.error('Sync machine reached a final state — terminating process for Kubernetes restart');
    process.exit(1);
  });

  machine.onEvent((event) => {
    logger.info(`Processing event: ${bigIntUtils.JSONBigInt.stringify(event.type)}`);
  });

  machine.start();
};
