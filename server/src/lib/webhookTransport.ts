import { isSuccessfulWebhookResponse } from '../domain/webhook';
import { logger } from './logger';

// A WebhookTransport abstraction so the rest of the codebase never talks to
// a customer's HTTP endpoint directly — mirroring how src/lib/
// paymentGateway.ts wraps the payment processor. Tests inject
// RecordingWebhookTransport to assert on exactly what would have been sent
// (headers, body, signature) without a network, and the service takes a
// transport as an argument so nothing about delivery has to be mocked at
// the module level.

export interface WebhookRequest {
  url: string;
  /** The exact serialized JSON body that was signed — never re-serialized downstream. */
  payload: string;
  headers: Record<string, string>;
}

export type WebhookTransportResponse =
  | { ok: true; status: number }
  // `status` is absent when the request never got a response at all (DNS
  // failure, connection refused, timeout), which is a different kind of
  // failure from a receiver that answered with a 500.
  | { ok: false; status?: number; error: string };

export interface WebhookTransport {
  send(request: WebhookRequest): Promise<WebhookTransportResponse>;
}

// A receiver that takes longer than this to respond is treated as failed
// and retried later. Kept short because a webhook receiver is expected to
// acknowledge and process asynchronously, not to do its work inline.
const REQUEST_TIMEOUT_MS = 10_000;

export class HttpWebhookTransport implements WebhookTransport {
  constructor(private readonly timeoutMs: number = REQUEST_TIMEOUT_MS) {}

  async send(request: WebhookRequest): Promise<WebhookTransportResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...request.headers },
        body: request.payload,
        // A webhook URL that has moved should be reconfigured by its owner,
        // not silently followed — chasing a redirect would also re-send a
        // signed payload to a host the signature wasn't meant for.
        redirect: 'manual',
        signal: controller.signal,
      });

      if (isSuccessfulWebhookResponse(response.status)) {
        return { ok: true, status: response.status };
      }

      return { ok: false, status: response.status, error: `Endpoint responded with ${response.status}` };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown transport error';
      logger.warn({ url: request.url, error }, 'Webhook delivery transport error');
      return { ok: false, error };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface RecordedWebhookRequest extends WebhookRequest {
  attempt: number;
}

// An in-memory transport for tests and local development. `respond` decides
// each attempt's outcome from the request and the 1-indexed attempt number,
// so a test can deterministically fail the first N sends and then succeed —
// the same trick src/lib/paymentGateway.ts's mock uses to exercise retry
// paths without randomness.
export class RecordingWebhookTransport implements WebhookTransport {
  readonly requests: RecordedWebhookRequest[] = [];

  constructor(
    private readonly respond: (
      request: WebhookRequest,
      attempt: number,
    ) => WebhookTransportResponse = () => ({ ok: true, status: 200 }),
  ) {}

  async send(request: WebhookRequest): Promise<WebhookTransportResponse> {
    const attempt = this.requests.filter((recorded) => recorded.url === request.url).length + 1;
    this.requests.push({ ...request, attempt });
    return this.respond(request, attempt);
  }

  get lastRequest(): RecordedWebhookRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  requestsForEvent(eventId: string): RecordedWebhookRequest[] {
    return this.requests.filter((request) => {
      try {
        return (JSON.parse(request.payload) as { id?: string }).id === eventId;
      } catch {
        return false;
      }
    });
  }

  reset(): void {
    this.requests.length = 0;
  }
}
