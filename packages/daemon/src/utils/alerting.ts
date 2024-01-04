/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Severity } from '../types';
import getConfig from '../config';
import logger from '../logger';
import { sendMessageSQS } from './aws';

/**
 * Adds a message to the SQS alerting queue
 *
 * @param title - The alert's title
 * @param message - The alert's message
 * @param severity - The alert's severity (critical, major, medium, minor, warning or info)
 * @param metadata - Key value object being the key the title
 */
export const addAlert = async (
  title: string,
  message: string,
  severity: Severity = Severity.INFO,
  metadata?: unknown,
): Promise<void> => {
  const {
    NETWORK,
    ACCOUNT_ID,
    SERVICE_NAME,
    ALERT_MANAGER_TOPIC,
    ALERT_MANAGER_REGION,
  } = getConfig();

  const preparedMessage = {
    title,
    message,
    severity,
    metadata,
    environment: NETWORK,
    application: SERVICE_NAME,
  };
   
  try {
    const QUEUE_URL = `https://sqs.${ALERT_MANAGER_REGION}.amazonaws.com/${ACCOUNT_ID}/${ALERT_MANAGER_TOPIC}`;

    await sendMessageSQS(QUEUE_URL, JSON.stringify(preparedMessage), {
      None: {
        DataType: 'String',
        StringValue: '--',
      },
    });
  } catch(err) {
    logger.error('[ALERT] Erroed while sending message to the alert sqs queue');
    logger.error(err);
  }
};
