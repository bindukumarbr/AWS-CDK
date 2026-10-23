/**
 * Orders API Lambda handler (HTTP API payload format 2.0).
 *
 * Deliberately small: the point of this repo is the infrastructure, not the business logic. What
 * matters here is that it is correct, validates input, logs structured JSON, and never leaks internals.
 *
 * Data model (see FoundationStack):
 *   PK orderId (uuid)  |  GSI byCustomer: customerId + createdAt (ISO-8601 sorts lexicographically)
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

// Created OUTSIDE the handler: reused across warm invocations (connection reuse, no per-request setup).
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE_NAME = process.env.TABLE_NAME;

interface OrderItem {
  sku: string;
  quantity: number;
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const log = (level: 'info' | 'error', message: string, extra: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ level, message, ...extra }));

function parseItems(value: unknown): OrderItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  const items: OrderItem[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { sku, quantity } = raw as Record<string, unknown>;
    if (typeof sku !== 'string' || sku.length === 0 || sku.length > 64) return null;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return null;
    items.push({ sku, quantity });
  }
  return items;
}

async function createOrder(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { message: 'Body must be valid JSON.' });
  }

  const customerId = payload.customerId;
  const items = parseItems(payload.items);
  if (typeof customerId !== 'string' || customerId.length === 0 || customerId.length > 64 || !items) {
    return json(400, { message: 'Required: customerId (string) and items [{ sku, quantity }] (1-50 items).' });
  }

  const order = {
    orderId: randomUUID(),
    customerId,
    items,
    status: 'PLACED',
    createdAt: new Date().toISOString(),
  };

  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: order,
      // Never overwrite an existing order, even in the (astronomically unlikely) event of a uuid collision.
      ConditionExpression: 'attribute_not_exists(orderId)',
    }),
  );
  return json(201, order);
}

async function getOrder(orderId: string): Promise<APIGatewayProxyResultV2> {
  const result = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { orderId } }));
  return result.Item ? json(200, result.Item) : json(404, { message: 'Order not found.' });
}

async function listCustomerOrders(customerId: string): Promise<APIGatewayProxyResultV2> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'byCustomer',
      KeyConditionExpression: 'customerId = :c',
      ExpressionAttributeValues: { ':c': customerId },
      ScanIndexForward: false, // newest first
      Limit: 50, // bounded page: an unbounded Query is a latent latency and cost bug
    }),
  );
  return json(200, { items: result.Items ?? [], nextToken: result.LastEvaluatedKey ? 'more' : undefined });
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const requestId = event.requestContext.requestId;
  try {
    if (!TABLE_NAME) throw new Error('TABLE_NAME is not configured');

    switch (event.routeKey) {
      case 'POST /orders':
        return await createOrder(event);
      case 'GET /orders/{orderId}':
        return await getOrder(event.pathParameters?.orderId ?? '');
      case 'GET /customers/{customerId}/orders':
        return await listCustomerOrders(event.pathParameters?.customerId ?? '');
      default:
        return json(404, { message: 'Route not found.' });
    }
  } catch (err) {
    // Full detail goes to CloudWatch (with the request id to correlate); the client gets a generic message.
    log('error', 'unhandled error', { requestId, error: err instanceof Error ? err.message : String(err) });
    return json(500, { message: 'Internal server error.', requestId });
  }
};
