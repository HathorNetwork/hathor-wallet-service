import { Logger } from 'winston';
import { mockedAddAlert } from '@tests/utils/alerting.utils.mock';
import { connectionInfoFromEvent, sendMessageToClient } from '@src/ws/utils';
import { Severity } from '@wallet-service/common/src/types';

import { logger } from '@tests/winston.mock';
import { RedisClient } from 'redis';
import {
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { RedisConfig } from '@src/types';

const mockedSend = jest.fn();

jest.mock('@src/redis', () => {
  const originalModule = jest.requireActual('@src/redis');
  return {
    ...originalModule,
    endWsConnection: jest.fn(),
  };
});

jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => {
  const originalModule = jest.requireActual('@aws-sdk/client-apigatewaymanagementapi');
  return {
    ...originalModule,
    ApiGatewayManagementApiClient: jest.fn().mockImplementation(() => ({
      send: mockedSend,
    })),
  };
});

jest.mock('redis', () => ({
  RedisClient: jest.fn().mockImplementation(() => ({
    endWsConnection: jest.fn(),
    on: jest.fn(),
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    quit: jest.fn(),
  })),
}));

import { endWsConnection } from '@src/redis';

test('connectionInfoFromEvent', async () => {
  expect.hasAssertions();
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const event = {
    requestContext: {
      connectionId: 'abc123',
      domainName: 'dom123',
      stage: 'test123',
    },
  };
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const connInfo = connectionInfoFromEvent(event);
  expect(connInfo).toStrictEqual({ id: 'abc123', url: `https://${process.env.WS_DOMAIN}` });
});

test('missing WS_DOMAIN should throw', () => {
  expect.hasAssertions();

  delete process.env.WS_DOMAIN;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const event = {
    requestContext: {
      connectionId: 'abc123',
      domainName: 'dom123',
      stage: 'test123',
    },
  };

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  expect(() => connectionInfoFromEvent(event)).toThrow('Domain not on env variables');
  expect(mockedAddAlert).toHaveBeenCalledWith(
    'Erroed while fetching connection info',
    'Domain not on env variables',
    Severity.MINOR,
    null,
    expect.any(Logger),
  );
});

describe('sendMessageToClient', () => {
  let client: any;
  const redisConfig: RedisConfig = {
    url: 'http://doesntmatter.com',
    password: 'password',
  };
  const connInfo = { url: 'http://example.com', id: '1234' };
  const message = 'hello';

  beforeEach(() => {
    jest.clearAllMocks();
    client = new RedisClient(redisConfig);
  });

  it('should send a message successfully', async () => {
    mockedSend.mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
    });

    await sendMessageToClient(client, connInfo, message);

    expect(mockedSend).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        ConnectionId: connInfo.id,
        Data: JSON.stringify(message),
      })
    }));

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('should log and throw an error if API Gateway returns non-200 status', async () => {
    mockedSend.mockResolvedValue({
      $metadata: { httpStatusCode: 400 },
    });

    await sendMessageToClient(client, connInfo, message);

    expect(mockedAddAlert).toHaveBeenCalledWith(
      'Unhandled error while sending websocket message to client',
      'The wallet-service was unable to handle an error while attempting to send a message to a websocket client. Please check the logs.',
      Severity.MINOR,
      {
        ConnectionId: connInfo.id,
        Message: JSON.stringify(message),
      }
    );
  });

  it('should handle GoneException by closing the connection', async () => {
    mockedSend.mockRejectedValue(new GoneException({
      message: 'Connection is gone.',
      $metadata: {
        httpStatusCode: 410,
      }
    }));

    await sendMessageToClient(client, connInfo, message);
    expect(endWsConnection).toHaveBeenCalledWith(client, connInfo.id);
  });
});
