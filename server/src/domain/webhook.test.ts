import { describe, expect, it } from 'vitest';
import {
  buildEventEnvelope,
  buildSignatureHeader,
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  eventMatchesFilter,
  isSuccessfulWebhookResponse,
  MAX_WEBHOOK_ATTEMPTS,
  nextWebhookAttemptAt,
  parseSignatureHeader,
  signWebhookPayload,
  signedPayloadString,
  verifyWebhookSignature,
  webhookRetryDelayMs,
} from './webhook';

const SECRET = 'whsec_test_secret_value';
const PAYLOAD = '{"id":"evt_1","type":"invoice.paid"}';
const NOW = new Date('2026-04-01T00:00:00.000Z');

describe('eventMatchesFilter', () => {
  it('matches an exact event type', () => {
    expect(eventMatchesFilter(['invoice.paid'], 'invoice.paid')).toBe(true);
    expect(eventMatchesFilter(['invoice.paid'], 'invoice.voided')).toBe(false);
  });

  it('matches a whole namespace with a trailing wildcard', () => {
    expect(eventMatchesFilter(['invoice.*'], 'invoice.created')).toBe(true);
    expect(eventMatchesFilter(['invoice.*'], 'payment.failed')).toBe(false);
  });

  it('matches everything with a bare wildcard', () => {
    expect(eventMatchesFilter(['*'], 'dunning.exhausted')).toBe(true);
  });

  it('matches if any one pattern matches', () => {
    expect(eventMatchesFilter(['payment.*', 'invoice.paid'], 'invoice.paid')).toBe(true);
  });

  it('matches nothing for an empty subscription list', () => {
    expect(eventMatchesFilter([], 'invoice.paid')).toBe(false);
  });

  it('ignores an unknown pattern instead of throwing', () => {
    expect(eventMatchesFilter(['not-an-event', 'invoice.paid'], 'invoice.paid')).toBe(true);
    expect(eventMatchesFilter(['not-an-event'], 'invoice.paid')).toBe(false);
  });

  it('does not let a namespace wildcard match a longer prefix', () => {
    expect(eventMatchesFilter(['invoice.*'], 'invoices.created')).toBe(false);
  });
});

describe('webhookRetryDelayMs', () => {
  it('grows exponentially between attempts', () => {
    expect(webhookRetryDelayMs(1)).toBe(30_000);
    expect(webhookRetryDelayMs(2)).toBe(120_000);
    expect(webhookRetryDelayMs(3)).toBe(480_000);
  });

  it('clamps to the maximum delay', () => {
    expect(webhookRetryDelayMs(20)).toBe(6 * 60 * 60 * 1000);
  });

  it('rejects a non-positive attempt count', () => {
    expect(() => webhookRetryDelayMs(0)).toThrow(/positive integer/);
  });
});

describe('nextWebhookAttemptAt', () => {
  it('schedules the next attempt relative to the failure', () => {
    expect(nextWebhookAttemptAt(1, NOW)?.toISOString()).toBe('2026-04-01T00:00:30.000Z');
  });

  it('returns null once the attempt budget is spent', () => {
    expect(nextWebhookAttemptAt(MAX_WEBHOOK_ATTEMPTS, NOW)).toBeNull();
  });
});

describe('signWebhookPayload', () => {
  it('is deterministic for the same secret, payload, and timestamp', () => {
    expect(signWebhookPayload(SECRET, PAYLOAD, 1772000000)).toBe(
      signWebhookPayload(SECRET, PAYLOAD, 1772000000),
    );
  });

  it('changes when any input changes', () => {
    const base = signWebhookPayload(SECRET, PAYLOAD, 1772000000);

    expect(signWebhookPayload('other-secret', PAYLOAD, 1772000000)).not.toBe(base);
    expect(signWebhookPayload(SECRET, `${PAYLOAD} `, 1772000000)).not.toBe(base);
    expect(signWebhookPayload(SECRET, PAYLOAD, 1772000001)).not.toBe(base);
  });

  it('binds the timestamp into the signed material', () => {
    expect(signedPayloadString(1772000000, PAYLOAD)).toBe(`1772000000.${PAYLOAD}`);
  });
});

describe('buildSignatureHeader / parseSignatureHeader', () => {
  it('emits a timestamp and a v1 signature', () => {
    const header = buildSignatureHeader(SECRET, PAYLOAD, NOW);

    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('round-trips through the parser', () => {
    const header = buildSignatureHeader(SECRET, PAYLOAD, NOW);
    const parsed = parseSignatureHeader(header);

    expect(parsed?.timestampSeconds).toBe(Math.floor(NOW.getTime() / 1000));
    expect(parsed?.signatures).toHaveLength(1);
  });

  it('collects every v1 signature during a secret rotation', () => {
    const parsed = parseSignatureHeader('t=1772000000,v1=aaa,v1=bbb');

    expect(parsed?.signatures).toEqual(['aaa', 'bbb']);
  });

  it('rejects a header with no timestamp or no signature', () => {
    expect(parseSignatureHeader('v1=aaa')).toBeNull();
    expect(parseSignatureHeader('t=1772000000')).toBeNull();
    expect(parseSignatureHeader('t=not-a-number,v1=aaa')).toBeNull();
    expect(parseSignatureHeader('')).toBeNull();
  });

  it('ignores unknown signature versions', () => {
    expect(parseSignatureHeader('t=1772000000,v0=aaa')).toBeNull();
    expect(parseSignatureHeader('t=1772000000,v0=aaa,v1=bbb')?.signatures).toEqual(['bbb']);
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a signature we just produced', () => {
    const header = buildSignatureHeader(SECRET, PAYLOAD, NOW);

    expect(verifyWebhookSignature(SECRET, PAYLOAD, header, { now: NOW })).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const header = buildSignatureHeader('another-secret', PAYLOAD, NOW);

    expect(verifyWebhookSignature(SECRET, PAYLOAD, header, { now: NOW })).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const header = buildSignatureHeader(SECRET, PAYLOAD, NOW);

    expect(verifyWebhookSignature(SECRET, '{"id":"evt_2"}', header, { now: NOW })).toBe(false);
  });

  it('rejects a replayed payload outside the tolerance window', () => {
    const header = buildSignatureHeader(SECRET, PAYLOAD, NOW);
    const later = new Date(NOW.getTime() + (DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 1) * 1000);

    expect(verifyWebhookSignature(SECRET, PAYLOAD, header, { now: later })).toBe(false);
  });

  it('accepts a payload still inside the tolerance window', () => {
    const header = buildSignatureHeader(SECRET, PAYLOAD, NOW);
    const later = new Date(NOW.getTime() + (DEFAULT_SIGNATURE_TOLERANCE_SECONDS - 1) * 1000);

    expect(verifyWebhookSignature(SECRET, PAYLOAD, header, { now: later })).toBe(true);
  });

  it('rejects a timestamp too far in the future', () => {
    const header = buildSignatureHeader(SECRET, PAYLOAD, new Date(NOW.getTime() + 3_600_000));

    expect(verifyWebhookSignature(SECRET, PAYLOAD, header, { now: NOW })).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(verifyWebhookSignature(SECRET, PAYLOAD, 'garbage', { now: NOW })).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifyWebhookSignature(SECRET, PAYLOAD, `t=${Math.floor(NOW.getTime() / 1000)},v1=abc`, { now: NOW })).toBe(
      false,
    );
  });
});

describe('buildEventEnvelope', () => {
  it('serializes an envelope receivers can parse', () => {
    const payload = buildEventEnvelope({
      id: 'evt_1',
      type: 'invoice.paid',
      createdAt: NOW.toISOString(),
      organizationId: 'org_1',
      data: { invoiceId: 'inv_1' },
    });

    expect(JSON.parse(payload)).toEqual({
      id: 'evt_1',
      type: 'invoice.paid',
      createdAt: '2026-04-01T00:00:00.000Z',
      organizationId: 'org_1',
      data: { invoiceId: 'inv_1' },
    });
  });
});

describe('isSuccessfulWebhookResponse', () => {
  it('accepts any 2xx', () => {
    expect(isSuccessfulWebhookResponse(200)).toBe(true);
    expect(isSuccessfulWebhookResponse(204)).toBe(true);
  });

  it('rejects redirects and errors', () => {
    expect(isSuccessfulWebhookResponse(302)).toBe(false);
    expect(isSuccessfulWebhookResponse(410)).toBe(false);
    expect(isSuccessfulWebhookResponse(500)).toBe(false);
  });
});
