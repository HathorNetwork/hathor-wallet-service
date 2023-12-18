/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Severity } from '../types';
import getConfig from '../config';
import logger from '../logger';

/**
 * Adds a message to the SQS alerting queue
 *
 * @param fnName - The lambda function name
 * @param payload - The payload to be sent
 */
export const addAlert = async (
  title: string,
  message: string,
  severity: Severity,
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

  const QUEUE_URL = `https://sqs.${ALERT_MANAGER_REGION}.amazonaws.com/${ACCOUNT_ID}/${ALERT_MANAGER_TOPIC}`;

  const client = new SQSClient({});
  const command = new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify(preparedMessage),
    MessageAttributes: {
      None: {
        DataType: 'String',
        StringValue: '--',
      },
    },
  });

  try {
    await client.send(command);
  } catch(err) {
    logger.error('[ALERT] Erroed while sending message to the alert sqs queue', err);
  }
};
