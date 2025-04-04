import middy from '@middy/core'
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'
import errorHandler from '@src/api/middlewares/errorHandler';

test('errorHandler should return an error response', () => {
  expect.hasAssertions();
  const middleware = errorHandler();
  const request: middy.Request<APIGatewayProxyEvent, APIGatewayProxyResult> = {
    event: {
      path: '/test',
    } as APIGatewayProxyEvent,
    context: {
      functionName: 'testFunction',
    } as middy.Request['context'],
    error: new Error('Boom'),
    response: { statusCode: 200, body: 'ok' },
    internal: {},
  };

  const response = middleware.onError(request);
  expect(response.statusCode).toBe(500);
  expect(response.body).toBe('Boom');
});
