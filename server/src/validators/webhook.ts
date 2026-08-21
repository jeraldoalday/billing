import { z } from 'zod';
import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_EVENT_TYPES } from '../domain/webhook';

// Every namespace that appears in the event catalogue, so `invoice.*` can be
// validated as a real subscription while `invoces.*` is caught at the API
// boundary rather than silently matching nothing forever.
const EVENT_NAMESPACES = Array.from(
  new Set(WEBHOOK_EVENT_TYPES.map((type) => type.split('.')[0] as string)),
);

const eventPatternSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (pattern) =>
      pattern === '*' ||
      (WEBHOOK_EVENT_TYPES as readonly string[]).includes(pattern) ||
      (pattern.endsWith('.*') && EVENT_NAMESPACES.includes(pattern.slice(0, -2))),
    {
      message: `Must be "*", a namespace wildcard (${EVENT_NAMESPACES.map((ns) => `${ns}.*`).join(', ')}), or a known event type`,
    },
  );

// Endpoints must be HTTP(S): the transport in src/lib/webhookTransport.ts
// only speaks HTTP, and accepting anything else (file:, gopher:) would turn
// an endpoint URL into a way to make the server fetch arbitrary schemes.
// Plain http is allowed because local development receivers (and test
// doubles) aren't served over TLS.
const endpointUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'Endpoint URL must use http or https',
  })
  .refine((value) => value.length <= 2000, { message: 'Endpoint URL is too long' });

export const createWebhookEndpointSchema = z.object({
  url: endpointUrlSchema,
  description: z.string().trim().max(200).optional(),
  // Defaulting to every event matches what a new integration almost always
  // wants; narrowing later is a single update call.
  enabledEvents: z.array(eventPatternSchema).min(1).max(50).default(['*']),
});
export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;

export const updateWebhookEndpointSchema = z
  .object({
    url: endpointUrlSchema.optional(),
    description: z.string().trim().max(200).nullable().optional(),
    enabledEvents: z.array(eventPatternSchema).min(1).max(50).optional(),
    active: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateWebhookEndpointInput = z.infer<typeof updateWebhookEndpointSchema>;

export const listWebhookEndpointsQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type ListWebhookEndpointsQuery = z.infer<typeof listWebhookEndpointsQuerySchema>;

export const listWebhookDeliveriesQuerySchema = z.object({
  endpointId: z.string().min(1).optional(),
  eventType: z.enum(WEBHOOK_EVENT_TYPES).optional(),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
});
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;
