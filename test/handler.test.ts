/**
 * Unit tests for the Lambda handler's validation and routing paths.
 * These run without AWS: every case below returns BEFORE any DynamoDB call.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// TABLE_NAME is read when the module loads, so set it first and `require` the handler afterwards
// (ES `import` statements are hoisted above any assignment).
let handler: (e: APIGatewayProxyEventV2) => Promise<unknown>;
beforeAll(() => {
  process.env.TABLE_NAME = 'test-table';
  ({ handler } = require('../app/orders-api/src/handler'));
});

const event = (routeKey: string, body?: unknown, pathParameters?: Record<string, string>): APIGatewayProxyEventV2 =>
  ({
    routeKey,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    pathParameters,
    requestContext: { requestId: 'req-1' },
  }) as unknown as APIGatewayProxyEventV2;

const call = async (e: APIGatewayProxyEventV2) => (await handler(e)) as { statusCode: number; body: string };

describe('POST /orders validation', () => {
  test('rejects malformed JSON', async () => {
    expect((await call(event('POST /orders', '{not json'))).statusCode).toBe(400);
  });

  test.each([
    ['missing customerId', { items: [{ sku: 'A', quantity: 1 }] }],
    ['empty items', { customerId: 'c1', items: [] }],
    ['non-integer quantity', { customerId: 'c1', items: [{ sku: 'A', quantity: 1.5 }] }],
    ['quantity too large', { customerId: 'c1', items: [{ sku: 'A', quantity: 100000 }] }],
    ['too many items', { customerId: 'c1', items: Array.from({ length: 51 }, () => ({ sku: 'A', quantity: 1 })) }],
    ['items not an array', { customerId: 'c1', items: 'nope' }],
  ])('rejects %s', async (_name, body) => {
    const res = await call(event('POST /orders', body));
    expect(res.statusCode).toBe(400);
  });
});

describe('routing', () => {
  test('unknown route returns 404', async () => {
    expect((await call(event('DELETE /orders/{orderId}'))).statusCode).toBe(404);
  });
});
