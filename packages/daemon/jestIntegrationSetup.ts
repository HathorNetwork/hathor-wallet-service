/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Integration test environment setup.
 * Mocks addAlert so MonitoringActor does not attempt real SQS/SNS connections
 * in environments where AWS credentials / region are not configured.
 */
jest.mock('@wallet-service/common', () => ({
  ...jest.requireActual('@wallet-service/common'),
  addAlert: jest.fn().mockResolvedValue(undefined),
}));
