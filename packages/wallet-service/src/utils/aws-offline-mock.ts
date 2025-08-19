/**
 * AWS SDK Mock for Local Development
 *
 * This module provides mock implementations of AWS services when running offline.
 * It prevents the AWS SDK from attempting to connect to EC2 metadata service.
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

// Check if we're running in offline mode
const isOffline = process.env.IS_OFFLINE === 'true' || process.env.NODE_ENV === 'test';

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

  if (isOffline) {
    console.log('[AWS Mock] Creating mocked LambdaClient for offline development');
    clientConfig.credentials = mockCredentials;
    clientConfig.endpoint = config.endpoint || 'http://localhost:3002';

    // Create a mock client that doesn't actually call AWS
    const mockClient = {
      send: async (command: InvokeCommand) => {
        console.log('[AWS Mock] Intercepted Lambda invoke:', {
          functionName: command.input.FunctionName,
          invocationType: command.input.InvocationType,
          payload: command.input.Payload ? JSON.parse(command.input.Payload as string) : null,
        });

        // Return a successful response for Event invocations
        if (command.input.InvocationType === 'Event') {
          return { StatusCode: 202 };
        }

        // Return a mock response for synchronous invocations
        return {
          StatusCode: 200,
          Payload: JSON.stringify({ success: true }),
        };
      },
    };

    return mockClient as any;
  } else {
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
    }
    return new LambdaClient(clientConfig);
  }
}

/**
 * Create an ApiGatewayManagementApiClient with proper configuration for offline/online mode
 */
export function createApiGatewayManagementApiClient(config: { endpoint?: string; region?: string } = {}) {
  const clientConfig: any = {
    region: config.region || process.env.AWS_REGION || 'us-east-1',
  };

  if (isOffline) {
    console.log('[AWS Mock] Creating mocked ApiGatewayManagementApiClient for offline development');
    clientConfig.credentials = mockCredentials;

    const mockClient = {
      send: async (command: PostToConnectionCommand) => {
        console.log('[AWS Mock] Intercepted API Gateway post to connection:', {
          connectionId: command.input.ConnectionId,
          data: command.input.Data,
        });

        return { StatusCode: 200 };
      },
    };

    return mockClient as any;
  } else {
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
    }
    return new ApiGatewayManagementApiClient(clientConfig);
  }
}

/**
 * Create an SQSClient with proper configuration for offline/online mode
 */
export function createSQSClient(config: { endpoint?: string; region?: string } = {}) {
  const clientConfig: any = {
    region: config.region || process.env.AWS_REGION || 'us-east-1',
  };

  if (isOffline) {
    console.log('[AWS Mock] Creating mocked SQSClient for offline development');
    clientConfig.credentials = mockCredentials;

    const mockClient = {
      send: async (command: SendMessageCommand) => {
        console.log('[AWS Mock] Intercepted SQS send message:', {
          queueUrl: command.input.QueueUrl,
          messageBody: command.input.MessageBody,
        });

        return {
          MessageId: 'mock-message-id-' + Date.now(),
          MD5OfBody: 'mock-md5-hash',
        };
      },
    };

    return mockClient as any;
  } else {
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
    }
    return new SQSClient(clientConfig);
  }
}
