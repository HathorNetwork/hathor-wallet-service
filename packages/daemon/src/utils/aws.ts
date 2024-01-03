import { SendNotificationToDevice, Severity, WalletBalanceValue } from "../types";
import { LambdaClient, InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { SendMessageCommand, SendMessageCommandOutput, SQSClient } from '@aws-sdk/client-sqs';
import { StringMap } from '../types';
import getConfig from '../config';
import logger from '../logger';
import { addAlert } from "./alerting";

export function buildFunctionName(functionName: string): string {
  const { STAGE } = getConfig();
  return `hathor-wallet-service-${STAGE}-${functionName}`;
}

/**
 * Invokes this application's own intermediary lambda `OnTxPushNotificationRequestedLambda`.
 * @param walletBalanceValueMap - a map of walletId linked to its wallet balance data.
 */
export const invokeOnTxPushNotificationRequestedLambda = async (walletBalanceValueMap: StringMap<WalletBalanceValue>): Promise<void> => {
  const {
    PUSH_NOTIFICATION_ENABLED,
    WALLET_SERVICE_LAMBDA_ENDPOINT,
    ON_TX_PUSH_NOTIFICATION_REQUESTED_FUNCTION_NAME,
  } = getConfig();

  if (!PUSH_NOTIFICATION_ENABLED) {
    logger.debug('Push notification is disabled. Skipping invocation of OnTxPushNotificationRequestedLambda lambda.');
    return;
  }

  const client = new LambdaClient({
    endpoint: WALLET_SERVICE_LAMBDA_ENDPOINT,
    region: 'local',
  });

  const command = new InvokeCommand({
    FunctionName: ON_TX_PUSH_NOTIFICATION_REQUESTED_FUNCTION_NAME,
    InvocationType: 'Event',
    Payload: JSON.stringify(walletBalanceValueMap),
  });

  const response: InvokeCommandOutput = await client.send(command);

  // Event InvocationType returns 202 for a successful invokation
  const walletIdList = Object.keys(walletBalanceValueMap);
  if (response.StatusCode !== 202) {
    await addAlert(
      'Error on PushNotificationUtils',
      `${ON_TX_PUSH_NOTIFICATION_REQUESTED_FUNCTION_NAME} lambda invoke failed for wallets`,
      Severity.MINOR,
      { Wallets: walletIdList },
    );
    throw new Error(`${ON_TX_PUSH_NOTIFICATION_REQUESTED_FUNCTION_NAME} lambda invoke failed for wallets: ${walletIdList}`);
  }
}

/**
 * Sends a message to a specific SQS queue
*
 * @param messageBody - A string with the message body
 * @param queueUrl - The queue URL
 */
export const sendMessageSQS = async (messageBody: string, queueUrl: string): Promise<SendMessageCommandOutput> => {
  const client = new SQSClient({});
  const command = new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: messageBody,
  });

  return client.send(command);
};
