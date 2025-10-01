/**
 * Copyright (c) Hathor Labs and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AWS Utils and mocker for Local Development -- Common Package
 *
 * This module provides mock implementations of AWS services when running offline AND in a private network without
 * EC2 instances available, for example when running inside a Dockerized private network.
 *
 * When requested, it prevents the AWS SDK from attempting to connect to EC2 metadata service.
 *
 * This behavior could be further improved by adding conditional logic to the requests themselves, but this will be
 * considered and planned in the future if needed.
 */

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import winston from 'winston'

/**
 * Mock credentials for offline development
 */
const mockCredentials = {
  accessKeyId: 'mock-access-key',
  secretAccessKey: 'mock-secret-key',
  sessionToken: 'mock-session-token',
};

/**
 * Create an SQSClient with proper configuration for offline/online mode
 */
export function createSQSClient(sqsConfig: { endpoint?: string; region?: string } = {}, envConfig: {
  shouldMockAWS?: boolean,
  logger?: winston.Logger
} = { shouldMockAWS: false, logger: undefined }){
  const clientConfig: any = {
    region: sqsConfig.region || process.env.AWS_REGION || 'us-east-1',
  };

  // If not mocking, return a real SQSClient
  if (!envConfig.shouldMockAWS) {
    if (sqsConfig.endpoint) {
      clientConfig.endpoint = sqsConfig.endpoint;
    }
    return new SQSClient(clientConfig);
  }
  envConfig.logger?.log({
    level: 'debug',
    message: `[AWS Common Utils] Creating a mocked SQSClient`,
    clientConfig
  });
  clientConfig.credentials = mockCredentials;
  clientConfig.endpoint = sqsConfig.endpoint;

  // Create a mock client that doesn't actually call AWS
  const mockClient = {
    send: async (command: SendMessageCommand) => {
      envConfig.logger?.log({
        level: 'debug',
        message: '[AWS Mock] Intercepted SQS send:',
        sendData: {
          queueUrl: command.input.QueueUrl,
          messageBody: command.input.MessageBody,
          messageAttributes: command.input.MessageAttributes,
        },
      });
      // Return a mock response
      return { MessageId: 'mock-message-id', ResponseMetadata: { RequestId: 'mock-request-id' } };
    },
  };

  return mockClient as any;
}
