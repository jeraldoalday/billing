import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ApiClient, ApiError } from '../api/client';
import { AuthProvider } from '../auth/AuthContext';
import { createMemorySessionStore, type StoredSession } from '../auth/sessionStorage';

/**
 * Test harness: renders a tree inside a real router and a real
 * AuthProvider, with only `fetch` replaced. Pages therefore exercise their
 * genuine navigation, guards, and client code — the seam is at the network
 * boundary, which is the one place a test cannot use the real thing.
 */

/** Canned responses keyed by `"METHOD /path"`; an ApiError value fails. */
export type Responses = Record<string, unknown>;

export interface RecordedRequest {
  method: string;
  path: string;
  /** The serialized query string, including the `?`, or '' when there is none. */
  query: string;
  body: unknown;
  token: string | null;
}

export interface RenderAppOptions {
  responses?: Responses;
  session?: StoredSession | null;
  route?: string;
}

export interface RenderAppResult extends RenderResult {
  requests: RecordedRequest[];
  store: ReturnType<typeof createMemorySessionStore>;
}

export const TEST_SESSION: StoredSession = {
  token: 'tok_test',
  user: { id: 'usr_1', email: 'owner@acme.test', name: 'Ada Lovelace' },
  organization: { id: 'org_1', name: 'Acme Inc', slug: 'acme-inc' },
};

/** A zero-state summary report, the shape GET /reports/summary returns. */
export const EMPTY_SUMMARY = {
  mrr: { mrr: 0, subscriptions: 0, customers: 0, arpu: 0, groupBy: 'plan', breakdown: [] },
  churn: {
    from: '2026-07-26T00:00:00.000Z',
    to: '2026-08-25T00:00:00.000Z',
    subscriptions: { atStart: 0, churned: 0, churnRate: 0, retentionRate: 100 },
    customers: { atStart: 0, churned: 0, churnRate: 0 },
  },
  revenue: {
    from: '2026-07-26T00:00:00.000Z',
    to: '2026-08-25T00:00:00.000Z',
    invoices: 0,
    grossRevenue: 0,
    discounts: 0,
    tax: 0,
    netRevenue: 0,
    outstanding: 0,
  },
};

export function renderApp(ui: ReactNode, options: RenderAppOptions = {}): RenderAppResult {
  const responses = options.responses ?? {};
  const requests: RecordedRequest[] = [];
  const store = createMemorySessionStore(options.session ?? null);

  const createClient = (clientOptions: {
    getToken: () => string | null;
    onUnauthorized: () => void;
  }) => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        path: url.pathname,
        query: url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        token: clientOptions.getToken(),
      });

      const canned = responses[`${method} ${url.pathname}`];
      // A promise stands in for a request that is still in flight, which is
      // how a test holds a page in its loading state.
      if (canned instanceof Promise) {
        return canned as Promise<Response>;
      }
      if (canned instanceof ApiError) {
        return {
          ok: false,
          status: canned.status,
          text: async () =>
            JSON.stringify({
              error: { code: canned.code, message: canned.message, details: canned.details },
            }),
        } as Response;
      }
      if (canned instanceof Error) {
        throw canned;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(canned ?? {}),
      } as Response;
    }) as unknown as typeof fetch;

    return new ApiClient({ baseUrl: 'http://api.test', fetchImpl, ...clientOptions });
  };

  const result = render(
    <AuthProvider store={store} createClient={createClient}>
      <MemoryRouter initialEntries={[options.route ?? '/']}>{ui}</MemoryRouter>
    </AuthProvider>,
  );

  return { ...result, requests, store };
}

/** Builds a validation failure shaped exactly like the server's. */
export function validationError(fieldErrors: Record<string, string[]>): ApiError {
  return new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', {
    formErrors: [],
    fieldErrors,
  });
}
