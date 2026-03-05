/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import logger from '../logger';
import getConfig from '../config';
import { Event, EventTypes } from '../types';
import { getDbConnection, fetchAddressBalance, fetchAddressTxHistorySum, fetchAllDistinctAddresses } from '../db';
import { addAlert, Severity } from '@wallet-service/common';

const runValidation = async (config = getConfig()) => {
  let mysql;

  try {
    mysql = await getDbConnection();
    let offset = 0;
    const batchSize = config.BALANCE_VALIDATION_BATCH_SIZE;
    let totalAddresses = 0;
    let totalMismatches = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const addresses = await fetchAllDistinctAddresses(mysql, batchSize, offset);

      if (addresses.length === 0) {
        break;
      }

      totalAddresses += addresses.length;

      const addressBalances = await fetchAddressBalance(mysql, addresses);
      const addressTxHistorySums = await fetchAddressTxHistorySum(mysql, addresses);

      // Filter out zero-transaction address balances (same logic as validateAddressBalances)
      const filteredAddressBalances = addressBalances.filter(
        (addressBalance) => addressBalance.transactions > 0
      );

      for (let i = 0; i < addressTxHistorySums.length; i++) {
        const addressBalance = filteredAddressBalances[i];
        const addressTxHistorySum = addressTxHistorySums[i];

        if (!addressBalance || !addressTxHistorySum) {
          logger.error(`Balance validation: array length mismatch at index ${i}`, {
            filteredAddressBalancesLength: filteredAddressBalances.length,
            addressTxHistorySumsLength: addressTxHistorySums.length,
          });
          totalMismatches++;
          continue;
        }

        if (addressBalance.tokenId !== addressTxHistorySum.tokenId) {
          logger.error(`Balance validation mismatch: tokenId mismatch for address ${addressBalance.address}`, {
            addressBalanceTokenId: addressBalance.tokenId,
            txHistoryTokenId: addressTxHistorySum.tokenId,
          });
          totalMismatches++;
          continue;
        }

        const balanceFromTable = Number(addressBalance.unlockedBalance + addressBalance.lockedBalance);
        const balanceFromHistory = Number(addressTxHistorySum.balance);

        if (balanceFromTable !== balanceFromHistory) {
          logger.error(`Balance validation mismatch for address ${addressBalance.address}, token ${addressBalance.tokenId}`, {
            addressBalanceTotal: balanceFromTable,
            txHistoryBalance: balanceFromHistory,
          });
          totalMismatches++;
        }
      }

      offset += addresses.length;
    }

    if (totalMismatches > 0) {
      await addAlert(
        'Balance validation found mismatches',
        `Found ${totalMismatches} balance mismatch(es) across ${totalAddresses} addresses`,
        Severity.MAJOR,
        { totalAddresses, totalMismatches },
        logger,
      );
    } else {
      logger.info(`Balance validation complete, no mismatches found (${totalAddresses} addresses checked)`);
    }
  } catch (err) {
    logger.error(`Balance validation error: ${err}`);
  } finally {
    if (mysql) {
      (mysql as any).release();
    }
  }
};

export default (callback: any, receive: any, config = getConfig()) => {
  if (!config.BALANCE_VALIDATION_ENABLED) {
    logger.info('Balance validation feature is disabled. Not starting balance validation actor');

    return () => {};
  }

  logger.info('Starting balance validation actor');

  let validationTimer: NodeJS.Timer | null = null;

  const createValidationTimer = () => {
    if (validationTimer) {
      clearValidationTimer();
    }

    validationTimer = setInterval(async () => {
      logger.info('Starting scheduled balance validation');
      await runValidation(config);
    }, config.BALANCE_VALIDATION_INTERVAL_MS);
  };

  const clearValidationTimer = () => {
    if (validationTimer) {
      clearInterval(validationTimer);
      validationTimer = null;
    }
  };

  receive((event: Event) => {
    if (event.type !== EventTypes.BALANCE_VALIDATION_EVENT) {
      logger.warn('Event of a different type than BALANCE_VALIDATION_EVENT reached the balance validation actor');

      return;
    }

    if (event.event.type === 'STOP') {
      logger.info('Stopping balance validation');
      clearValidationTimer();
    }

    if (event.event.type === 'START') {
      logger.info('Starting balance validation');
      createValidationTimer();
    }
  });

  return () => {
    logger.info('Stopping balance validation actor');
    clearValidationTimer();
  };
};
