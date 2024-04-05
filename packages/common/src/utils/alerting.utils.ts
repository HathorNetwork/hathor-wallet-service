/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Severity } from '../types';
import { assertEnvVariablesExistence } from './index.utils';
import { Logger } from 'winston';

assertEnvVariablesExistence([
  'NETWORK',
  'APPLICATION_NAME',
  'ACCOUNT_ID',
  'ALERT_MANAGER_REGION',
  'ALERT_MANAGER_TOPIC',
]);

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
  // XXX: logger is temporarily coming as a param until we refactor the logger
  // to be a common util between projects, metadata will also be refactored
  // to be a optional parameter.
  metadata: unknown = null,
  logger: Logger,
): Promise<void> => {
  const preparedMessage = {
    title,
    message,
    severity,
    metadata,
    environment: process.env.NETWORK,
    application: process.env.APPLICATION_NAME,
  };

  const {
    ACCOUNT_ID,
    ALERT_MANAGER_REGION,
    ALERT_MANAGER_TOPIC,
  } = process.env;

  const QUEUE_URL = `https://sqs.${ALERT_MANAGER_REGION}.amazonaws.com/${ACCOUNT_ID}/${ALERT_MANAGER_TOPIC}`;

  const client = new SQSClient({
    endpoint: QUEUE_URL,
    region: ALERT_MANAGER_REGION,
  });
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
