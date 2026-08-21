import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { RecordingWebhookTransport } from '../lib/webhookTransport';
import { MAX_WEBHOOK_ATTEMPTS, verifyWebhookSignature } from '../domain/webhook';
import * as webhookService from './webhook.service';

const NOW = new Date('2026-05-01T00:00:00.000Z');

async function resetDb() {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

async function createOrg(slug = 'acme') {
  return prisma.organization.create({ data: { name: 'Acme', slug } });
}

const originalTransport = webhookService.getWebhookTransport();

beforeEach(resetDb);
afterEach(() => {
  webhookService.setWebhookTransport(originalTransport);
});
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('createWebhookEndpoint', () => {
  it('generates a secret and returns it in full exactly once', async () => {
    const org = await createOrg();

    const created = await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });

    expect(created.secret).toMatch(/^whsec_[0-9a-f]{48}$/);

    const read = await webhookService.getWebhookEndpoint(org.id, created.id);
    expect(read.secret).not.toBe(created.secret);
    expect(read.secret).toContain('...');
  });

  it('parses enabledEvents back into an array', async () => {
    const org = await createOrg();

    const created = await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['invoice.*', 'payment.failed'],
    });

    expect(created.enabledEvents).toEqual(['invoice.*', 'payment.failed']);
  });

  it('rejects a duplicate url within the same organization', async () => {
    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });

    await expect(
      webhookService.createWebhookEndpoint(org.id, {
        url: 'https://hooks.test/billing',
        enabledEvents: ['*'],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('allows the same url in a different organization', async () => {
    const orgA = await createOrg('acme');
    const orgB = await createOrg('globex');

    await webhookService.createWebhookEndpoint(orgA.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });

    await expect(
      webhookService.createWebhookEndpoint(orgB.id, {
        url: 'https://hooks.test/billing',
        enabledEvents: ['*'],
      }),
    ).resolves.toMatchObject({ url: 'https://hooks.test/billing' });
  });
});

describe('rotateWebhookEndpointSecret', () => {
  it('issues a different secret and reveals it', async () => {
    const org = await createOrg();
    const created = await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });

    const rotated = await webhookService.rotateWebhookEndpointSecret(org.id, created.id);

    expect(rotated.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(rotated.secret).not.toBe(created.secret);
  });

  it('404s for another organization endpoint', async () => {
    const orgA = await createOrg('acme');
    const orgB = await createOrg('globex');
    const created = await webhookService.createWebhookEndpoint(orgA.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });

    await expect(webhookService.rotateWebhookEndpointSecret(orgB.id, created.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('emitEvent', () => {
  it('delivers a signed payload the receiver can verify', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const org = await createOrg();
    const endpoint = await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });

    await webhookService.emitEvent(org.id, 'invoice.paid', { invoiceId: 'inv_1' }, { now: NOW });

    expect(transport.requests).toHaveLength(1);
    const sent = transport.lastRequest;
    expect(sent?.headers['webhook-event-type']).toBe('invoice.paid');
    expect(
      verifyWebhookSignature(endpoint.secret, sent?.payload ?? '', sent?.headers['webhook-signature'] ?? '', {
        now: NOW,
      }),
    ).toBe(true);
    expect(JSON.parse(sent?.payload ?? '{}')).toMatchObject({
      type: 'invoice.paid',
      organizationId: org.id,
      data: { invoiceId: 'inv_1' },
    });
  });

  it('marks a delivery succeeded when the receiver returns 2xx', async () => {
    webhookService.setWebhookTransport(new RecordingWebhookTransport());
    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });

    const [delivery] = await webhookService.emitEvent(org.id, 'invoice.paid', {}, { now: NOW });

    expect(delivery?.status).toBe('SUCCEEDED');
    expect(delivery?.attemptsMade).toBe(1);
    expect(delivery?.deliveredAt?.toISOString()).toBe(NOW.toISOString());
    expect(delivery?.nextAttemptAt).toBeNull();
  });

  it('only delivers to endpoints subscribed to the event', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/invoices',
      enabledEvents: ['invoice.*'],
    });
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/payments',
      enabledEvents: ['payment.failed'],
    });

    await webhookService.emitEvent(org.id, 'invoice.paid', {}, { now: NOW });

    expect(transport.requests.map((request) => request.url)).toEqual(['https://hooks.test/invoices']);
  });

  it('skips disabled endpoints', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const org = await createOrg();
    const endpoint = await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });
    await webhookService.updateWebhookEndpoint(org.id, endpoint.id, { active: false });

    const deliveries = await webhookService.emitEvent(org.id, 'invoice.paid', {}, { now: NOW });

    expect(deliveries).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it('never delivers to another organization endpoint', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const orgA = await createOrg('acme');
    const orgB = await createOrg('globex');
    await webhookService.createWebhookEndpoint(orgB.id, {
      url: 'https://hooks.test/other-org',
      enabledEvents: ['*'],
    });

    const deliveries = await webhookService.emitEvent(orgA.id, 'invoice.paid', {}, { now: NOW });

    expect(deliveries).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it('gives every endpoint the same event id for one emitted event', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/one',
      enabledEvents: ['*'],
    });
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/two',
      enabledEvents: ['*'],
    });

    const deliveries = await webhookService.emitEvent(org.id, 'invoice.created', {}, { now: NOW });

    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((delivery) => delivery.eventId)).size).toBe(1);
    expect(transport.requestsForEvent(deliveries[0]?.eventId ?? '')).toHaveLength(2);
  });

  it('schedules a retry when the receiver fails', async () => {
    webhookService.setWebhookTransport(
      new RecordingWebhookTransport(() => ({ ok: false, status: 500, error: 'boom' })),
    );

    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });

    const [delivery] = await webhookService.emitEvent(org.id, 'invoice.paid', {}, { now: NOW });

    expect(delivery?.status).toBe('PENDING');
    expect(delivery?.attemptsMade).toBe(1);
    expect(delivery?.responseStatus).toBe(500);
    expect(delivery?.nextAttemptAt?.toISOString()).toBe('2026-05-01T00:00:30.000Z');
  });

  it('leaves the delivery unattempted when delivery is deferred', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });

    const [delivery] = await webhookService.emitEvent(
      org.id,
      'invoice.paid',
      {},
      { now: NOW, deferDelivery: true },
    );

    expect(transport.requests).toHaveLength(0);
    expect(delivery?.status).toBe('PENDING');
    expect(delivery?.attemptsMade).toBe(0);
  });

  it('does not throw when the transport itself blows up', async () => {
    webhookService.setWebhookTransport({
      send: async () => {
        throw new Error('transport exploded');
      },
    });

    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });

    await expect(webhookService.emitEvent(org.id, 'invoice.paid', {}, { now: NOW })).resolves.toHaveLength(1);
  });
});

describe('retryDueWebhookDeliveries', () => {
  it('re-attempts a due delivery and can recover it', async () => {
    const transport = new RecordingWebhookTransport((_request, attempt) =>
      attempt === 1 ? { ok: false, status: 500, error: 'boom' } : { ok: true, status: 200 },
    );
    webhookService.setWebhookTransport(transport);

    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });
    await webhookService.emitEvent(org.id, 'invoice.paid', {}, { now: NOW });

    const later = new Date(NOW.getTime() + 60_000);
    const [retried] = await webhookService.retryDueWebhookDeliveries(org.id, { now: later });

    expect(retried?.status).toBe('SUCCEEDED');
    expect(retried?.attemptsMade).toBe(2);
    expect(transport.requests).toHaveLength(2);
  });

  it('skips a delivery whose retry is not due yet', async () => {
    webhookService.setWebhookTransport(
      new RecordingWebhookTransport(() => ({ ok: false, status: 500, error: 'boom' })),
    );

    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });
    await webhookService.emitEvent(org.id, 'invoice.paid', {}, { now: NOW });

    const soon = new Date(NOW.getTime() + 1_000);
    await expect(webhookService.retryDueWebhookDeliveries(org.id, { now: soon })).resolves.toHaveLength(0);
  });

  it('gives up and marks the delivery failed once the budget is spent', async () => {
    webhookService.setWebhookTransport(
      new RecordingWebhookTransport(() => ({ ok: false, error: 'connection refused' })),
    );

    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });
    await webhookService.emitEvent(org.id, 'invoice.paid', {}, { now: NOW });

    let attempts = 1;
    let last;
    while (attempts < MAX_WEBHOOK_ATTEMPTS) {
      // Sweeping far in the future makes every remaining retry due at once,
      // so the whole budget can be exercised without waiting out the backoff.
      // eslint-disable-next-line no-await-in-loop -- each sweep must observe the previous one's state
      const [delivery] = await webhookService.retryDueWebhookDeliveries(org.id, {
        now: new Date(NOW.getTime() + attempts * 86_400_000),
      });
      last = delivery;
      attempts += 1;
    }

    expect(last?.attemptsMade).toBe(MAX_WEBHOOK_ATTEMPTS);
    expect(last?.status).toBe('FAILED');
    expect(last?.error).toBe('connection refused');
    expect(last?.nextAttemptAt).toBeNull();
  });

  it('does not retry another organization deliveries', async () => {
    webhookService.setWebhookTransport(
      new RecordingWebhookTransport(() => ({ ok: false, status: 500, error: 'boom' })),
    );

    const orgA = await createOrg('acme');
    const orgB = await createOrg('globex');
    await webhookService.createWebhookEndpoint(orgA.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });
    await webhookService.emitEvent(orgA.id, 'invoice.paid', {}, { now: NOW });

    const later = new Date(NOW.getTime() + 60_000);
    await expect(webhookService.retryDueWebhookDeliveries(orgB.id, { now: later })).resolves.toHaveLength(0);
  });
});

describe('redeliverWebhookDelivery', () => {
  it('queues a copy carrying the original payload', async () => {
    const transport = new RecordingWebhookTransport();
    webhookService.setWebhookTransport(transport);

    const org = await createOrg();
    await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });
    const [original] = await webhookService.emitEvent(org.id, 'invoice.paid', { n: 1 }, { now: NOW });

    const copy = await webhookService.redeliverWebhookDelivery(org.id, original?.id ?? '');

    expect(copy.id).not.toBe(original?.id);
    expect(copy.eventId).toBe(original?.eventId);
    expect(copy.payload).toBe(original?.payload);
    expect(copy.status).toBe('SUCCEEDED');
    expect(transport.requests).toHaveLength(2);
  });

  it('refuses to redeliver to a disabled endpoint', async () => {
    webhookService.setWebhookTransport(new RecordingWebhookTransport());

    const org = await createOrg();
    const endpoint = await webhookService.createWebhookEndpoint(org.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });
    const [original] = await webhookService.emitEvent(org.id, 'invoice.paid', {}, { now: NOW });
    await webhookService.updateWebhookEndpoint(org.id, endpoint.id, { active: false });

    await expect(
      webhookService.redeliverWebhookDelivery(org.id, original?.id ?? ''),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('404s for another organization delivery', async () => {
    webhookService.setWebhookTransport(new RecordingWebhookTransport());

    const orgA = await createOrg('acme');
    const orgB = await createOrg('globex');
    await webhookService.createWebhookEndpoint(orgA.id, {
      url: 'https://hooks.test/billing',
      enabledEvents: ['*'],
    });
    const [original] = await webhookService.emitEvent(orgA.id, 'invoice.paid', {}, { now: NOW });

    await expect(
      webhookService.redeliverWebhookDelivery(orgB.id, original?.id ?? ''),
    ).rejects.toMatchObject({ status: 404 });
  });
});
