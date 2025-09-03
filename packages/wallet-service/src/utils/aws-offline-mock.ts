/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AWS SDK Mock for Local Development
 *
 * This module provides mock implementations of AWS services when running offline AND in a private network without
 * EC2 instances available, for example when running inside a Dockerized private network.
 *
 * It prevents the AWS SDK from attempting to connect to EC2 metadata service.
 *
 * This behavior could be further improved by adding conditional logic to the requests themselves, but this will be
 * considered and planned in the future if needed.
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import createDefaultLogger from '@src/logger'

/**
 * Flag to determine if AWS services should be mocked
 * It is set by default via the MOCK_AWS environment variable, but can be adjusted programmatically,
 * especially for testing environments.
 */
export let shouldMockAWS = process.env.MOCK_AWS === 'true';

/**
 * Set whether to mock AWS services
 * @param value
 */
export function setShouldMockAWS(value: boolean) {
  shouldMockAWS = value;
}

/**
 * Mock credentials for offline development
 */
const mockCredentials = {
  accessKeyId: 'mock-access-key',
  secretAccessKey: 'mock-secret-key',
  sessionToken: 'mock-session-token',
};

/**
 * Create a LambdaClient with proper configuration for offline/online mode
 */
export function createLambdaClient(config: { endpoint?: string; region?: string } = {}) {
  const clientConfig: any = {
    region: config.region || process.env.AWS_REGION || 'us-east-1',
  };

  // If not mocking, return a real LambdaClient
  if (!shouldMockAWS) {
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
    }
    return new LambdaClient(clientConfig);
  }

  const logger = createDefaultLogger();
  logger.log({level: 'debug', message: '[AWS Mock] Creating mocked LambdaClient for offline development'});
  clientConfig.credentials = mockCredentials;
  clientConfig.endpoint = config.endpoint || 'http://localhost:3002';

  // Create a mock client that doesn't actually call AWS
  const mockClient = {
    send: async (command: InvokeCommand) => {
      logger.log({
        level: 'debug', message: '[AWS Mock] Intercepted Lambda invoke:', invocationData: {
          functionName: command.input.FunctionName,
          invocationType: command.input.InvocationType,
          payload: command.input.Payload ? JSON.parse(command.input.Payload as string) : null,
        }
      });

      // Return a successful response for Event invocations
      if (command.input.InvocationType === 'Event') {
        return {StatusCode: 202};
      }

      // Return a mock response for synchronous invocations
      return {
        StatusCode: 200,
        Payload: JSON.stringify({success: true}),
      };
    },
  };

  return mockClient as any;
}

/**
 * Create an ApiGatewayManagementApiClient with proper configuration for offline/online mode
 */
export function createApiGatewayManagementApiClient(config: { endpoint?: string; region?: string } = {}) {
  const clientConfig: any = {
    region: config.region || process.env.AWS_REGION || 'us-east-1',
  };

  // If not mocking, return a real ApiGatewayManagementApiClient
  if (!shouldMockAWS) {
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
    }
    return new ApiGatewayManagementApiClient(clientConfig);
  }

  const logger = createDefaultLogger();
  logger.log({
    level: 'debug',
    message: '[AWS Mock] Creating mocked ApiGatewayManagementApiClient for offline development'
  });
  clientConfig.credentials = mockCredentials;

  const mockClient = {
    send: async (command: PostToConnectionCommand) => {
      logger.log({
        level: 'debug',
        message: '[AWS Mock] Intercepted API Gateway post to connection:',
        postData: {
          connectionId: command.input.ConnectionId,
          data: command.input.Data,
        }
      });

      return {StatusCode: 200};
    },
  };

  return mockClient as any;
}
