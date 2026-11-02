import { describe, expect, it } from 'vitest';
import { createWebhookEndpointSchema } from './webhook';

describe('createWebhookEndpointSchema', () => {
  it('accepts an ordinary https endpoint', () => {
    const result = createWebhookEndpointSchema.safeParse({ url: 'https://example.com/hooks/billing' });
    expect(result.success).toBe(true);
  });

  it('accepts plain http for local development receivers', () => {
    const result = createWebhookEndpointSchema.safeParse({ url: 'http://example.com/hooks' });
    expect(result.success).toBe(true);
  });

  it('rejects a non-http(s) scheme', () => {
    const result = createWebhookEndpointSchema.safeParse({ url: 'ftp://example.com/hooks' });
    expect(result.success).toBe(false);
  });

  it('rejects an endpoint pointing at localhost', () => {
    const result = createWebhookEndpointSchema.safeParse({ url: 'http://localhost:4000/hooks' });
    expect(result.success).toBe(false);
  });

  it('rejects an endpoint pointing at a private IPv4 address', () => {
    const result = createWebhookEndpointSchema.safeParse({ url: 'http://10.0.0.5/hooks' });
    expect(result.success).toBe(false);
  });

  it('rejects an endpoint pointing at the cloud metadata address', () => {
    const result = createWebhookEndpointSchema.safeParse({ url: 'http://169.254.169.254/latest/meta-data' });
    expect(result.success).toBe(false);
  });

  it('defaults enabledEvents to a bare wildcard', () => {
    const result = createWebhookEndpointSchema.safeParse({ url: 'https://example.com/hooks' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabledEvents).toEqual(['*']);
    }
  });
});
