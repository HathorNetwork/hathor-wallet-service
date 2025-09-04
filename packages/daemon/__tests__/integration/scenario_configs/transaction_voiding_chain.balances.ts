/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Expected balances for the TRANSACTION_VOIDING_CHAIN scenario
 *
 * This scenario tests the wallet service's ability to handle a chain of transactions
 * being voided, including proper unspending of inputs and balance recalculation.
 *
 * Since the scenario uses random seed, addresses may vary between runs.
 * We validate the balance distribution pattern instead of exact addresses.
 */

const EXPECTED = {
  // Expected balance distribution from simulator output: exactly these amounts should exist
  // Note: Main address includes genesis balance (1000000 * 100) + actual balance (73900)
  balanceDistribution: [73900, 5900, 3400, 0],
  // Total expected addresses (including the zero-balance address)
  totalAddresses: 4,
  // Token ID for all balances
  tokenId: '00'
};

export default EXPECTED;
