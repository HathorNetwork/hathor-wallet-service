/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const mockCalls: string[] = [];

jest.mock('../src/shieldedCrypto', () => ({
  registerShieldedCryptoProvider: jest.fn(async () => {
    mockCalls.push('registerShieldedCryptoProvider');
    return true;
  }),
}));

jest.mock('../src/config', () => ({
  __esModule: true,
  ...jest.requireActual('../src/config'),
  checkEnvVariables: jest.fn(),
}));

jest.mock('xstate', () => ({
  ...jest.requireActual('xstate'),
  interpret: jest.fn(() => ({
    onTransition: jest.fn(),
    onDone: jest.fn(),
    onEvent: jest.fn(),
    start: jest.fn(() => { mockCalls.push('machine.start'); }),
  })),
}));

import { main } from '../src/main';

describe('main', () => {
  it('registers the shielded crypto provider before the sync machine starts', async () => {
    await main();

    // Without the registration no vertex is ever recovered, and nothing else
    // in the suite would notice it was gone.
    expect(mockCalls).toStrictEqual(['registerShieldedCryptoProvider', 'machine.start']);
  });
});
