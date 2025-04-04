import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { RedisClient } from 'redis';
import { addAlert } from '@wallet-service/common/src/utils/alerting.utils';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  PostToConnectionCommandOutput,
  DeleteConnectionCommand,
  DeleteConnectionCommandOutput,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { Logger } from 'winston';
import createDefaultLogger from '@src/logger';
import config from '@src/config';
import util from 'util';

import { Severity } from '@wallet-service/common/src/types';
import { WsConnectionInfo } from '@src/types';
import { endWsConnection } from '@src/redis';

const logger = createDefaultLogger();

export const connectionInfoFromEvent = (
  event: APIGatewayProxyEvent,
): WsConnectionInfo => {
  const logger: Logger = createDefaultLogger();
  const connID = event.requestContext.connectionId;
  if (config.isOffline) {
    // This will enter when running the service on serverless offline mode
    return {
      id: connID,
      url: 'http://localhost:3001',
    };
  }

  const domain = config.wsDomain;

  if (!domain) {
    addAlert(
      'Erroed while fetching connection info',
      'Domain not on env variables',
      Severity.MINOR,
      null,
      logger,
    );

    // Throw so we receive an alert telling us that something is wrong with the env variable
    // instead of trying to invoke a lambda at https://undefined
    throw new Error('Domain not on env variables');
  }

  return {
    id: connID,
    url: util.format('https://%s', domain),
  };
};

export const sendMessageToClient = async (
  client: RedisClient,
  connInfo: WsConnectionInfo,
  payload: any, // eslint-disable-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any
): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const apiGwClient = new ApiGatewayManagementApiClient({
    endpoint: connInfo.url,
  });

  const message = JSON.stringify(payload);

  const command = new PostToConnectionCommand({
    ConnectionId: connInfo.id,
    Data: message,
  });

  try {
    const response: PostToConnectionCommandOutput = await apiGwClient.send(command);

    if (response.$metadata.httpStatusCode !== 200) {
      logger.error(response.$metadata);
      throw new Error(`Status code from post to connection is not 200: ${response.$metadata.httpStatusCode}`);
    }
  } catch (e) {
    if (e instanceof GoneException) {
      logger.debug(`Received GONE exception, closing ${connInfo.id}`);
      return endWsConnection(client, connInfo.id);
    }

    logger.error(e);

    // Unhandled exception. We shouldn't end the connection as it might be a temporary
    // instability with api gateway.
    //
    // Alert and move on, no need to throw here
    addAlert(
      'Unhandled error while sending websocket message to client',
      'The wallet-service was unable to handle an error while attempting to send a message to a websocket client. Please check the logs.',
      Severity.MINOR,
      {
        ConnectionId: connInfo.id,
        Message: message,
      },
      logger,
    )
  }
};

/* istanbul ignore next */
export const disconnectClient = async (
  client: RedisClient,
  connInfo: WsConnectionInfo,
): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const apiGwClient = new ApiGatewayManagementApiClient({
    endpoint: connInfo.url,
  });

  const command = new DeleteConnectionCommand({
    ConnectionId: connInfo.id,
  });

  const response: DeleteConnectionCommandOutput = await apiGwClient.send(command);

  if (response.$metadata.httpStatusCode === 410) {
    // cleanup connection and subscriptions from redis if GONE
    return endWsConnection(client, connInfo.id);
  }
};

export const DEFAULT_API_GATEWAY_RESPONSE: APIGatewayProxyResult = {
  statusCode: 200,
  body: '',
};
