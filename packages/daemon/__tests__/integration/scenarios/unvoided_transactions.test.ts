/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { SyncMachine } from '../../../src/machines';
import { interpret } from 'xstate';

jest.mock('../../../src/config', () => ({

});

// const UNVOIDED_SCENARIO_PORT = 8081;

beforeAll(() => {

  // Mock config to return our env variables
});

describe('unvoided transaction scenario', () => {
  it('should do a full sync and the balances should match', () => {
    const machine = interpret(SyncMachine);

    machine.start();
  });
});
