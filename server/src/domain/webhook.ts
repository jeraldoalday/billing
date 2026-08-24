import { createHmac, timingSafeEqual } from 'node:crypto';

// Everything about an outbound webhook that doesn't need a database or a
// network: the catalogue of event types, which endpoint subscribes to what,
// how a payload is signed, and how a failed delivery backs off. The service
// that stores endpoints and actually sends deliveries lives in
// src/services/webhook.service.ts.

// The events this platform emits. Types are namespaced `resource.action` so
// an endpoint can subscribe to a whole namespace with a wildcard (see
// eventMatchesFilter below) rather than having to enumerate every action.
export const WEBHOOK_EVENT_TYPES = [
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.voided',
  'payment.succeeded',
  'payment.failed',
  'subscription.created',
  'subscription.updated',
  'subscription.renewed',
  'subscription.canceled',
  'dunning.started',
  'dunning.attempt_failed',
  'dunning.recovered',
  'dunning.exhausted',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

// SQLite has no native enum type (see prisma/schema.prisma), so
// WebhookDelivery's `status` column is a plain string. PENDING covers both
// "never attempted" and "failed but still has attempts left" — the
// difference is visible in attemptsMade/nextAttemptAt, and collapsing them
// keeps the retry sweep a single-status query.
export const WEBHOOK_DELIVERY_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

// Total delivery attempts (including the first, immediate one) before a
// delivery is marked FAILED and left alone. Deliberately more generous than
// the payment gateway's budget in src/services/payment.service.ts: a
// customer's HTTP endpoint being down for a few minutes is common and
// costs us nothing to wait out, whereas re-charging a card is not free.
export const MAX_WEBHOOK_ATTEMPTS = 5;

const WEBHOOK_BASE_DELAY_MS = 30_000;
const WEBHOOK_BACKOFF_FACTOR = 4;
// Caps the exponential so the last retries in a long budget stay within a
// few hours rather than drifting out to days.
const WEBHOOK_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

// The signature scheme version prefix, so a future change to how the
// signed string is built can be rolled out alongside the current one (an
// endpoint would receive both `v1=` and `v2=` during the transition)
// without breaking receivers pinned to v1.
const SIGNATURE_VERSION = 'v1';

// How far a delivery's timestamp may be from the receiver's clock before
// verifyWebhookSignature rejects it. Five minutes is enough slack for
// ordinary clock skew and queueing while still making a captured payload
// useless to replay later.
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

// Whether an endpoint subscribed to `patterns` should receive `eventType`.
// A pattern is either `*` (everything), `resource.*` (a whole namespace),
// or an exact event type. Unknown/typo'd patterns simply match nothing
// rather than throwing, so one bad entry in an endpoint's subscription list
// can't take down delivery of its other events.
export function eventMatchesFilter(patterns: readonly string[], eventType: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') {
      return true;
    }
    if (pattern.endsWith('.*')) {
      return eventType.startsWith(pattern.slice(0, -1));
    }
    return pattern === eventType;
  });
}

// Delay before attempt number `attemptsMade + 1`, growing exponentially and
// clamped to WEBHOOK_MAX_DELAY_MS. Pure and clock-free; callers turn it
// into an absolute instant with nextWebhookAttemptAt.
export function webhookRetryDelayMs(attemptsMade: number): number {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) {
    throw new Error('attemptsMade must be a positive integer');
  }

  const delay = WEBHOOK_BASE_DELAY_MS * WEBHOOK_BACKOFF_FACTOR ** (attemptsMade - 1);
  return Math.min(delay, WEBHOOK_MAX_DELAY_MS);
}

// When the next delivery attempt becomes due, or null once the attempt
// budget is spent (the caller should then mark the delivery FAILED).
export function nextWebhookAttemptAt(attemptsMade: number, from: Date): Date | null {
  if (attemptsMade >= MAX_WEBHOOK_ATTEMPTS) {
    return null;
  }

  return new Date(from.getTime() + webhookRetryDelayMs(attemptsMade));
}

// The exact string that gets HMAC'd. Binding the timestamp into the signed
// material (rather than signing the body alone) is what makes the signature
// non-replayable: a receiver checking freshness knows the timestamp it
// checked is the one the sender committed to.
export function signedPayloadString(timestampSeconds: number, payload: string): string {
  return `${timestampSeconds}.${payload}`;
}

export function signWebhookPayload(
  secret: string,
  payload: string,
  timestampSeconds: number,
): string {
  return createHmac('sha256', secret).update(signedPayloadString(timestampSeconds, payload)).digest('hex');
}

// The value of the outbound signature header, e.g.
// `t=1772000000,v1=9f86d0...`. Mirrors the shape used by well-known
// processors so receivers can reuse verification code they already have.
export function buildSignatureHeader(secret: string, payload: string, timestamp: Date): string {
  const timestampSeconds = Math.floor(timestamp.getTime() / 1000);
  return `t=${timestampSeconds},${SIGNATURE_VERSION}=${signWebhookPayload(secret, payload, timestampSeconds)}`;
}

export interface ParsedSignatureHeader {
  timestampSeconds: number;
  /** Every v1 signature in the header; more than one appears during a secret rotation. */
  signatures: string[];
}

export function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  const parts = header.split(',').map((part) => part.trim());
  let timestampSeconds: number | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = part.slice(0, separatorIndex);
    const value = part.slice(separatorIndex + 1);

    if (key === 't') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      timestampSeconds = parsed;
    } else if (key === SIGNATURE_VERSION && value.length > 0) {
      signatures.push(value);
    }
  }

  if (timestampSeconds === null || signatures.length === 0) {
    return null;
  }

  return { timestampSeconds, signatures };
}

// Constant-time comparison that also tolerates length mismatches, which
// timingSafeEqual itself throws on. Hex digests of the same algorithm are
// always the same length, so a mismatch here means a malformed header
// rather than a timing-sensitive near-miss.
function signaturesMatch(expected: string, candidate: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const candidateBuffer = Buffer.from(candidate, 'utf8');
  if (expectedBuffer.length !== candidateBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, candidateBuffer);
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  now?: Date;
}

// Receiver-side verification. Lives here (rather than only in a customer's
// codebase) because it is the executable specification of the signing
// scheme — the tests verify what we send by the same rules a receiver
// would, so the two can't silently drift apart.
export function verifyWebhookSignature(
  secret: string,
  payload: string,
  header: string,
  options: VerifyOptions = {},
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    return false;
  }

  const { toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS, now = new Date() } = options;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - parsed.timestampSeconds) > toleranceSeconds) {
    return false;
  }

  const expected = signWebhookPayload(secret, payload, parsed.timestampSeconds);
  return parsed.signatures.some((signature) => signaturesMatch(expected, signature));
}

export interface WebhookEventEnvelope {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  organizationId: string;
  data: Record<string, unknown>;
}

// Builds the JSON body a receiver sees. Serialization happens once, at emit
// time, and the resulting string is what gets stored and signed (see
// prisma/schema.prisma's WebhookDelivery.payload) so a redelivery is
// byte-identical to the original.
export function buildEventEnvelope(envelope: WebhookEventEnvelope): string {
  return JSON.stringify(envelope);
}

// A response is a success only if the receiver answered 2xx. Anything else —
// including a redirect, which we deliberately don't follow, since a webhook
// URL that moved should be reconfigured rather than silently chased — is a
// failure worth retrying.
export function isSuccessfulWebhookResponse(status: number): boolean {
  return status >= 200 && status < 300;
}
