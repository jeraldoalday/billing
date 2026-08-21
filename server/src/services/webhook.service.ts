import { randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import {
  buildEventEnvelope,
  buildSignatureHeader,
  eventMatchesFilter,
  MAX_WEBHOOK_ATTEMPTS,
  nextWebhookAttemptAt,
  type WebhookEventType,
} from '../domain/webhook';
import {
  HttpWebhookTransport,
  RecordingWebhookTransport,
  type WebhookTransport,
} from '../lib/webhookTransport';
import type {
  CreateWebhookEndpointInput,
  ListWebhookDeliveriesQuery,
  ListWebhookEndpointsQuery,
  UpdateWebhookEndpointInput,
} from '../validators/webhook';

// Outside of tests the transport really posts over HTTP. Under NODE_ENV=test
// it defaults to an in-memory recorder so that no test — including ones that
// only happen to create an endpoint on the way to testing something else —
// can make a real outbound request. Tests that want to assert on what was
// sent install their own recorder with setWebhookTransport().
let transport: WebhookTransport =
  env.NODE_ENV === 'test' ? new RecordingWebhookTransport() : new HttpWebhookTransport();

export function setWebhookTransport(next: WebhookTransport): void {
  transport = next;
}

export function getWebhookTransport(): WebhookTransport {
  return transport;
}

// Only ever returned in full from create/rotate. Everything else sees the
// masked form, so a leaked list response can't be used to forge a signature.
function generateEndpointSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

function maskSecret(secret: string): string {
  return `${secret.slice(0, 11)}...${secret.slice(-4)}`;
}

type EndpointRow = {
  id: string;
  organizationId: string;
  url: string;
  description: string | null;
  secret: string;
  enabledEvents: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export interface SerializedWebhookEndpoint {
  id: string;
  organizationId: string;
  url: string;
  description: string | null;
  secret: string;
  enabledEvents: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// `enabledEvents` is stored as a JSON string (SQLite has no array column),
// so every read path goes through here to hand callers a real array — and
// to mask the secret unless this is the one response allowed to reveal it.
function serializeEndpoint(endpoint: EndpointRow, revealSecret = false): SerializedWebhookEndpoint {
  return {
    id: endpoint.id,
    organizationId: endpoint.organizationId,
    url: endpoint.url,
    description: endpoint.description,
    secret: revealSecret ? endpoint.secret : maskSecret(endpoint.secret),
    enabledEvents: parseEnabledEvents(endpoint.enabledEvents),
    active: endpoint.active,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}

// Defensive: the column is only ever written from a validated array, but a
// row hand-edited into invalid JSON shouldn't take down event emission for
// the whole organization — such an endpoint just subscribes to nothing.
function parseEnabledEvents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    logger.warn({ raw }, 'Webhook endpoint has unparseable enabledEvents; treating as no subscriptions');
    return [];
  }
}

export async function createWebhookEndpoint(
  organizationId: string,
  input: CreateWebhookEndpointInput,
): Promise<SerializedWebhookEndpoint> {
  const existing = await prisma.webhookEndpoint.findFirst({
    where: { organizationId, url: input.url },
  });
  if (existing) {
    throw ApiError.conflict('A webhook endpoint with this URL already exists');
  }

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      organizationId,
      url: input.url,
      description: input.description,
      secret: generateEndpointSecret(),
      enabledEvents: JSON.stringify(input.enabledEvents),
    },
  });

  // The only response that reveals the signing secret — it can't be read
  // back later, only rotated.
  return serializeEndpoint(endpoint, true);
}

export async function listWebhookEndpoints(
  organizationId: string,
  query: ListWebhookEndpointsQuery,
): Promise<SerializedWebhookEndpoint[]> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { organizationId, active: query.active },
    orderBy: { createdAt: 'desc' },
  });

  return endpoints.map((endpoint) => serializeEndpoint(endpoint));
}

// Scoping the lookup to organizationId means an endpoint belonging to
// another org 404s exactly like one that doesn't exist, rather than leaking
// a 403 that would confirm the id is real.
async function findEndpoint(organizationId: string, endpointId: string): Promise<EndpointRow> {
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: endpointId, organizationId },
  });

  if (!endpoint) {
    throw ApiError.notFound('Webhook endpoint not found');
  }

  return endpoint;
}

export async function getWebhookEndpoint(
  organizationId: string,
  endpointId: string,
): Promise<SerializedWebhookEndpoint> {
  return serializeEndpoint(await findEndpoint(organizationId, endpointId));
}

export async function updateWebhookEndpoint(
  organizationId: string,
  endpointId: string,
  input: UpdateWebhookEndpointInput,
): Promise<SerializedWebhookEndpoint> {
  await findEndpoint(organizationId, endpointId);

  if (input.url) {
    const clash = await prisma.webhookEndpoint.findFirst({
      where: { organizationId, url: input.url, id: { not: endpointId } },
    });
    if (clash) {
      throw ApiError.conflict('A webhook endpoint with this URL already exists');
    }
  }

  const endpoint = await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: {
      url: input.url,
      description: input.description,
      active: input.active,
      enabledEvents: input.enabledEvents ? JSON.stringify(input.enabledEvents) : undefined,
    },
  });

  return serializeEndpoint(endpoint);
}

// Issues a fresh secret and returns it in full, the same way create does.
// Pending deliveries are signed with whatever secret is current when each
// attempt is made, so a rotation applies to retries too — that's the point
// of rotating after a suspected leak.
export async function rotateWebhookEndpointSecret(
  organizationId: string,
  endpointId: string,
): Promise<SerializedWebhookEndpoint> {
  await findEndpoint(organizationId, endpointId);

  const endpoint = await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: { secret: generateEndpointSecret() },
  });

  return serializeEndpoint(endpoint, true);
}

export async function deleteWebhookEndpoint(organizationId: string, endpointId: string): Promise<void> {
  await findEndpoint(organizationId, endpointId);
  await prisma.webhookEndpoint.delete({ where: { id: endpointId } });
}

export async function listWebhookDeliveries(organizationId: string, query: ListWebhookDeliveriesQuery) {
  return prisma.webhookDelivery.findMany({
    where: {
      organizationId,
      endpointId: query.endpointId,
      eventType: query.eventType,
      status: query.status,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function getWebhookDelivery(organizationId: string, deliveryId: string) {
  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id: deliveryId, organizationId },
  });

  if (!delivery) {
    throw ApiError.notFound('Webhook delivery not found');
  }

  return delivery;
}

// Sends one delivery's stored payload to its endpoint and persists the
// outcome. Never throws on a transport failure — a customer's endpoint
// being down is an expected condition, recorded on the delivery row and
// retried later, not an error for the caller that emitted the event.
export async function attemptWebhookDelivery(deliveryId: string, now: Date = new Date()) {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });

  if (!delivery) {
    throw ApiError.notFound('Webhook delivery not found');
  }

  if (delivery.status !== 'PENDING') {
    throw ApiError.conflict(`Cannot attempt a delivery with status ${delivery.status}`);
  }

  const signature = buildSignatureHeader(delivery.endpoint.secret, delivery.payload, now);
  const response = await transport.send({
    url: delivery.endpoint.url,
    payload: delivery.payload,
    headers: {
      'webhook-id': delivery.id,
      'webhook-event-id': delivery.eventId,
      'webhook-event-type': delivery.eventType,
      'webhook-signature': signature,
    },
  });

  const attemptsMade = delivery.attemptsMade + 1;

  if (response.ok) {
    return prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'SUCCEEDED',
        attemptsMade,
        responseStatus: response.status,
        error: null,
        nextAttemptAt: null,
        deliveredAt: now,
      },
    });
  }

  const nextAttemptAt = nextWebhookAttemptAt(attemptsMade, now);

  return prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      // Out of attempts means FAILED and no further sweeps; otherwise it
      // stays PENDING with a due time, which is exactly what
      // retryDueWebhookDeliveries looks for.
      status: nextAttemptAt ? 'PENDING' : 'FAILED',
      attemptsMade,
      responseStatus: response.status ?? null,
      error: response.error.slice(0, 500),
      nextAttemptAt,
    },
  });
}

export interface EmitEventOptions {
  now?: Date;
  /** Skip the immediate first attempt and leave deliveries for the retry sweep. */
  deferDelivery?: boolean;
}

// Fans a domain event out to every active endpoint subscribed to it,
// recording one WebhookDelivery per endpoint and attempting each
// immediately. All failures — transport, database, malformed subscription
// lists — are swallowed and logged: emitting an event is a side effect of a
// billing action (charging an invoice, canceling a subscription) and must
// never be able to fail that action.
export async function emitEvent(
  organizationId: string,
  type: WebhookEventType,
  data: Record<string, unknown>,
  options: EmitEventOptions = {},
) {
  const now = options.now ?? new Date();

  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { organizationId, active: true },
    });
    const subscribed = endpoints.filter((endpoint) =>
      eventMatchesFilter(parseEnabledEvents(endpoint.enabledEvents), type),
    );

    if (subscribed.length === 0) {
      return [];
    }

    // One event id shared across every endpoint's delivery, so a receiver
    // that is registered twice can recognise the two bodies as the same
    // event, and support can trace one event across all its deliveries.
    const eventId = `evt_${randomUUID().replace(/-/g, '')}`;
    const payload = buildEventEnvelope({
      id: eventId,
      type,
      createdAt: now.toISOString(),
      organizationId,
      data,
    });

    const deliveries = await Promise.all(
      subscribed.map((endpoint) =>
        prisma.webhookDelivery.create({
          data: {
            organizationId,
            endpointId: endpoint.id,
            eventId,
            eventType: type,
            payload,
            status: 'PENDING',
            nextAttemptAt: now,
          },
        }),
      ),
    );

    if (options.deferDelivery) {
      return deliveries;
    }

    return await Promise.all(
      deliveries.map((delivery) =>
        attemptWebhookDelivery(delivery.id, now).catch((err) => {
          logger.error({ err, deliveryId: delivery.id }, 'Webhook delivery attempt failed');
          return delivery;
        }),
      ),
    );
  } catch (err) {
    logger.error({ err, organizationId, type }, 'Failed to emit webhook event');
    return [];
  }
}

export interface RetryDeliveriesOptions {
  now?: Date;
  limit?: number;
}

// Re-attempts every delivery whose retry is due. Called by an operator
// endpoint today and by Day 10's background worker later; sequential rather
// than parallel so a large backlog can't open hundreds of sockets at once.
export async function retryDueWebhookDeliveries(
  organizationId: string,
  options: RetryDeliveriesOptions = {},
) {
  const now = options.now ?? new Date();
  const due = await prisma.webhookDelivery.findMany({
    where: {
      organizationId,
      status: 'PENDING',
      nextAttemptAt: { lte: now },
      attemptsMade: { lt: MAX_WEBHOOK_ATTEMPTS },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: options.limit ?? 50,
  });

  const results = [];
  for (const delivery of due) {
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential so a backlog doesn't flood the network
    const attempted = await attemptWebhookDelivery(delivery.id, now).catch((err) => {
      logger.error({ err, deliveryId: delivery.id }, 'Webhook retry attempt failed');
      return null;
    });
    if (attempted) {
      results.push(attempted);
    }
  }

  return results;
}

// Queues a fresh delivery carrying an existing delivery's exact payload.
// A new row (rather than resetting the old one) keeps the original
// attempt history intact, which is the whole point of a delivery log.
export async function redeliverWebhookDelivery(
  organizationId: string,
  deliveryId: string,
  now: Date = new Date(),
) {
  const original = await getWebhookDelivery(organizationId, deliveryId);

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: original.endpointId, organizationId },
  });
  if (!endpoint) {
    throw ApiError.notFound('Webhook endpoint not found');
  }
  if (!endpoint.active) {
    throw ApiError.conflict('Cannot redeliver to a disabled endpoint');
  }

  const delivery = await prisma.webhookDelivery.create({
    data: {
      organizationId,
      endpointId: original.endpointId,
      eventId: original.eventId,
      eventType: original.eventType,
      payload: original.payload,
      status: 'PENDING',
      nextAttemptAt: now,
    },
  });

  return attemptWebhookDelivery(delivery.id, now);
}
