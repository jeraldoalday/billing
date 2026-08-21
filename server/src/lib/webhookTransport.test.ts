import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpWebhookTransport, RecordingWebhookTransport } from './webhookTransport';

const BASE_REQUEST = {
  url: 'https://example.test/hooks',
  payload: '{"id":"evt_1"}',
  headers: { 'webhook-signature': 't=1,v1=abc' },
};

describe('RecordingWebhookTransport', () => {
  it('records every request it is given', async () => {
    const transport = new RecordingWebhookTransport();

    await transport.send(BASE_REQUEST);
    await transport.send({ ...BASE_REQUEST, payload: '{"id":"evt_2"}' });

    expect(transport.requests).toHaveLength(2);
    expect(transport.lastRequest?.payload).toBe('{"id":"evt_2"}');
  });

  it('succeeds by default', async () => {
    const transport = new RecordingWebhookTransport();

    await expect(transport.send(BASE_REQUEST)).resolves.toEqual({ ok: true, status: 200 });
  });

  it('numbers attempts per url so a responder can fail then recover', async () => {
    const transport = new RecordingWebhookTransport((_request, attempt) =>
      attempt < 3 ? { ok: false, status: 500, error: 'boom' } : { ok: true, status: 200 },
    );

    const first = await transport.send(BASE_REQUEST);
    const second = await transport.send(BASE_REQUEST);
    const third = await transport.send(BASE_REQUEST);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(third).toEqual({ ok: true, status: 200 });
    expect(transport.requests.map((request) => request.attempt)).toEqual([1, 2, 3]);
  });

  it('counts attempts separately per endpoint url', async () => {
    const transport = new RecordingWebhookTransport();

    await transport.send(BASE_REQUEST);
    await transport.send({ ...BASE_REQUEST, url: 'https://other.test/hooks' });

    expect(transport.requests.map((request) => request.attempt)).toEqual([1, 1]);
  });

  it('finds the requests carrying a given event id', async () => {
    const transport = new RecordingWebhookTransport();

    await transport.send(BASE_REQUEST);
    await transport.send({ ...BASE_REQUEST, payload: '{"id":"evt_2"}' });
    await transport.send({ ...BASE_REQUEST, payload: 'not-json' });

    expect(transport.requestsForEvent('evt_1')).toHaveLength(1);
    expect(transport.requestsForEvent('evt_3')).toHaveLength(0);
  });

  it('clears its recording on reset', async () => {
    const transport = new RecordingWebhookTransport();

    await transport.send(BASE_REQUEST);
    transport.reset();

    expect(transport.requests).toHaveLength(0);
  });
});

describe('HttpWebhookTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the payload with its signature headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new HttpWebhookTransport().send(BASE_REQUEST);

    expect(result).toEqual({ ok: true, status: 204 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BASE_REQUEST.url);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(BASE_REQUEST.payload);
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'webhook-signature': 't=1,v1=abc',
    });
  });

  it('treats a non-2xx response as a retriable failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));

    const result = await new HttpWebhookTransport().send(BASE_REQUEST);

    expect(result).toEqual({ ok: false, status: 503, error: 'Endpoint responded with 503' });
  });

  it('does not follow a redirect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302 })));

    const result = await new HttpWebhookTransport().send(BASE_REQUEST);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 302 });
  });

  it('reports a connection error with no status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await new HttpWebhookTransport().send(BASE_REQUEST);

    expect(result).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });

  it('aborts a request that exceeds its timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
          }),
      ),
    );

    const result = await new HttpWebhookTransport(5).send(BASE_REQUEST);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: 'The operation was aborted' });
  });
});
