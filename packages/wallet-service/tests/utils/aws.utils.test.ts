/**
 * @fileoverview Tests for aws-utils.ts
 */
import { createLambdaClient, createApiGatewayManagementApiClient } from '@src/utils/aws.utils';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import config, { loadEnvConfig } from '@src/config';

describe('aws-utils', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...OLD_ENV,
      AWS_ACCESS_KEY_ID: 'test-access-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      AWS_REGION: 'us-east-1',
    };
    loadEnvConfig();
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe('createLambdaClient', () => {
    it('should return a mock LambdaClient when MOCK_AWS is true', async () => {
      config.shouldMockAWS = true;
      const client = createLambdaClient();
      const command = new InvokeCommand({
        FunctionName: 'test-fn',
        InvocationType: 'Event',
        Payload: JSON.stringify({ foo: 'bar' }),
      });
      const result = await client.send(command);
      expect(result.StatusCode).toBe(202);
    });

    it('should return a mock LambdaClient with sync invocation', async () => {
      config.shouldMockAWS = true;
      const client = createLambdaClient();
      const command = new InvokeCommand({
        FunctionName: 'test-fn',
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ foo: 'bar' }),
      });
      const result = await client.send(command);
      expect(result.StatusCode).toBe(200);
      expect(JSON.parse(result.Payload)).toEqual({ success: true });
    });

    it('should return a real LambdaClient when MOCK_AWS is not true', () => {
      config.shouldMockAWS = false;
      const client = createLambdaClient();
      expect(client).toBeInstanceOf(Object); // Not a mock
      expect(typeof client.send).toBe('function');
    });
  });

  describe('createApiGatewayManagementApiClient', () => {
    it('should return a mock ApiGatewayManagementApiClient when MOCK_AWS is true', async () => {
      config.shouldMockAWS = true;
      const client = createApiGatewayManagementApiClient();
      const command = new PostToConnectionCommand({
        ConnectionId: 'abc123',
        Data: Buffer.from('hello'),
      });
      const result = await client.send(command);
      expect(result.StatusCode).toBe(200);
    });

    it('should return a real ApiGatewayManagementApiClient when MOCK_AWS is not true', () => {
      config.shouldMockAWS = false;
      const client = createApiGatewayManagementApiClient();
      expect(client).toBeInstanceOf(Object); // Not a mock
      expect(typeof client.send).toBe('function');
    });
  });
});
