import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, buildQueryString, joinUrl, resolveApiBaseUrl } from './client';

const BASE_URL = 'http://api.test';

/** Builds a fetch stub that answers with one canned response. */
function respondWith(
  body: unknown,
  init: { status?: number; text?: string } = {},
): { fetchImpl: typeof fetch; calls: Array<[string, RequestInit | undefined]> } {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const status = init.status ?? 200;
  const text = init.text ?? (body === undefined ? '' : JSON.stringify(body));

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    calls.push([String(input), requestInit]);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

describe('buildQueryString', () => {
  it('returns an empty string when there are no params', () => {
    expect(buildQueryString(undefined)).toBe('');
    expect(buildQueryString({})).toBe('');
  });

  it('serializes strings, numbers, and booleans', () => {
    expect(buildQueryString({ status: 'ACTIVE', limit: 10, active: true })).toBe(
      '?status=ACTIVE&limit=10&active=true',
    );
  });

  // An `?active=` with no value would reach the server's Zod enum and come
  // back as a 400, so absent filters must not be serialized at all.
  it('drops undefined, null, and empty-string values', () => {
    expect(buildQueryString({ a: undefined, b: null, c: '', d: 'kept' })).toBe('?d=kept');
  });

  it('escapes values that are not URL-safe', () => {
    expect(buildQueryString({ email: 'a b+c@test.com' })).toBe('?email=a+b%2Bc%40test.com');
  });
});

describe('joinUrl', () => {
  it('joins with exactly one slash however each side is written', () => {
    expect(joinUrl('http://api.test', '/plans')).toBe('http://api.test/plans');
    expect(joinUrl('http://api.test/', '/plans')).toBe('http://api.test/plans');
    expect(joinUrl('http://api.test/', 'plans')).toBe('http://api.test/plans');
    expect(joinUrl('http://api.test', 'plans')).toBe('http://api.test/plans');
  });
});

describe('resolveApiBaseUrl', () => {
  it('uses the configured value', () => {
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: 'https://billing.example.com' })).toBe(
      'https://billing.example.com',
    );
  });

  it('falls back to the local server when unset or blank', () => {
    expect(resolveApiBaseUrl({})).toBe('http://localhost:4000');
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: '   ' })).toBe('http://localhost:4000');
  });
});

describe('ApiClient.request', () => {
  it('GETs a JSON body and returns it decoded', async () => {
    const { fetchImpl, calls } = respondWith({ plans: [{ id: 'plan_1' }] });
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    const plans = await client.listPlans();

    expect(plans).toEqual([{ id: 'plan_1' }]);
    expect(calls[0]?.[0]).toBe('http://api.test/plans');
    expect(calls[0]?.[1]?.method).toBe('GET');
  });

  it('attaches the bearer token when one is available', async () => {
    const { fetchImpl, calls } = respondWith({ customers: [] });
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl, getToken: () => 'tok_123' });

    await client.listCustomers();

    const headers = calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_123');
  });

  it('sends no Authorization header when logged out', async () => {
    const { fetchImpl, calls } = respondWith({ customers: [] });
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl, getToken: () => null });

    await client.listCustomers();

    const headers = calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  // The token is read per request rather than captured in the constructor,
  // so logging in mid-session doesn't require rebuilding the client.
  it('reads the token freshly on every request', async () => {
    const { fetchImpl, calls } = respondWith({ customers: [] });
    let token: string | null = null;
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl, getToken: () => token });

    await client.listCustomers();
    token = 'tok_after_login';
    await client.listCustomers();

    expect((calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok_after_login',
    );
  });

  it('serializes a POST body as JSON with a content type', async () => {
    const { fetchImpl, calls } = respondWith({ token: 't', user: {}, organization: {} });
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    await client.login({ email: 'a@test.com', password: 'secret123' });

    const [url, init] = calls[0] ?? [];
    expect(url).toBe('http://api.test/auth/login');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'a@test.com',
      password: 'secret123',
    });
  });

  it('appends query params to the path', async () => {
    const { fetchImpl, calls } = respondWith({ subscriptions: [] });
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    await client.listSubscriptions({ customerId: 'cus_1', status: 'ACTIVE' });

    expect(calls[0]?.[0]).toBe('http://api.test/subscriptions?customerId=cus_1&status=ACTIVE');
  });

  it('resolves to undefined for a 204 with no body', async () => {
    const { fetchImpl } = respondWith(undefined, { status: 204, text: '' });
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.delete('/customers/cus_1')).resolves.toBeUndefined();
  });

  it('throws ApiError carrying the server code and message', async () => {
    const { fetchImpl } = respondWith(
      { error: { code: 'NOT_FOUND', message: 'Plan not found' } },
      { status: 404 },
    );
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.getPlan('missing')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'NOT_FOUND',
      message: 'Plan not found',
    });
  });

  it('exposes per-field messages from a validation error', async () => {
    const { fetchImpl } = respondWith(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: {
            formErrors: [],
            fieldErrors: { password: ['String must contain at least 8 character(s)'] },
          },
        },
      },
      { status: 400 },
    );
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    const error = (await client
      .signup({ organizationName: 'Acme', email: 'a@test.com', password: 'short' })
      .catch((err: unknown) => err)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.fieldErrors.password).toEqual(['String must contain at least 8 character(s)']);
  });

  it('reports no field errors for a failure that is not a validation error', async () => {
    const { fetchImpl } = respondWith(
      { error: { code: 'CONFLICT', message: 'Already exists' } },
      { status: 409 },
    );
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    const error = (await client
      .createCustomer({ name: 'A', email: 'a@test.com' })
      .catch((err: unknown) => err)) as ApiError;

    expect(error.fieldErrors).toEqual({});
  });

  it('still throws something readable when the error body is not JSON', async () => {
    const { fetchImpl } = respondWith(undefined, { status: 502, text: '<html>bad gateway</html>' });
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    const error = (await client.listPlans().catch((err: unknown) => err)) as ApiError;

    expect(error.status).toBe(502);
    expect(error.message).toBe('Request failed with status 502');
  });

  it('turns a dead server into a NETWORK_ERROR rather than a raw TypeError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    const error = (await client.listPlans().catch((err: unknown) => err)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.status).toBe(0);
  });

  // A component that unmounted mid-request aborts on purpose; that must not
  // be reported to the user as the API being unreachable.
  it('rethrows an abort untouched', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    const error = (await client.listPlans().catch((err: unknown) => err)) as Error;

    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.name).toBe('AbortError');
  });

  it('notifies onUnauthorized when the token is rejected', async () => {
    const { fetchImpl } = respondWith(
      { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } },
      { status: 401 },
    );
    const onUnauthorized = vi.fn();
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl, onUnauthorized });

    const error = (await client.me().catch((err: unknown) => err)) as ApiError;

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(error.isUnauthorized).toBe(true);
  });

  it('does not notify onUnauthorized for other failures', async () => {
    const { fetchImpl } = respondWith(
      { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
      { status: 403 },
    );
    const onUnauthorized = vi.fn();
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl, onUnauthorized });

    await client.me().catch(() => undefined);

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('unwraps the envelope each resource endpoint returns', async () => {
    const { fetchImpl } = respondWith({ invoice: { id: 'in_1', number: 'INV-0001' } });
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.getInvoice('in_1')).resolves.toEqual({
      id: 'in_1',
      number: 'INV-0001',
    });
  });

  it('passes an abort signal through to fetch', async () => {
    const { fetchImpl, calls } = respondWith({ user: {}, organization: {} });
    const client = new ApiClient({ baseUrl: BASE_URL, fetchImpl });
    const controller = new AbortController();

    await client.me(controller.signal);

    expect(calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});

describe('ApiClient catalogue and customer writes', () => {
  function clientWith(body: unknown, init: { status?: number; text?: string } = {}) {
    const { fetchImpl, calls } = respondWith(body, init);
    return { client: new ApiClient({ baseUrl: BASE_URL, fetchImpl }), calls };
  }

  /** The JSON body a recorded call was made with. */
  function bodyOf(calls: Array<[string, RequestInit | undefined]>, index = 0): unknown {
    const raw = calls[index]?.[1]?.body;
    return raw === undefined ? undefined : JSON.parse(String(raw));
  }

  it('creates a flat plan', async () => {
    const { client, calls } = clientWith({ plan: { id: 'plan_1', name: 'Pro' } });

    await expect(
      client.createPlan({
        productId: 'prod_1',
        name: 'Pro',
        interval: 'MONTH',
        currency: 'usd',
        pricingModel: 'FLAT',
        flatAmount: 1999,
      }),
    ).resolves.toEqual({ id: 'plan_1', name: 'Pro' });

    expect(calls[0]?.[0]).toBe('http://api.test/plans');
    expect(calls[0]?.[1]?.method).toBe('POST');
    expect(bodyOf(calls)).toMatchObject({ pricingModel: 'FLAT', flatAmount: 1999 });
  });

  it('creates a tiered plan with its tiers', async () => {
    const { client, calls } = clientWith({ plan: { id: 'plan_2' } });

    await client.createPlan({
      productId: 'prod_1',
      name: 'Metered',
      interval: 'MONTH',
      pricingModel: 'TIERED',
      usageMetric: 'api_call',
      tiers: [
        { upTo: 1000, unitAmount: 5, flatFee: 0 },
        { upTo: null, unitAmount: 3, flatFee: 0 },
      ],
    });

    expect(bodyOf(calls)).toMatchObject({
      pricingModel: 'TIERED',
      usageMetric: 'api_call',
      tiers: [
        { upTo: 1000, unitAmount: 5 },
        { upTo: null, unitAmount: 3 },
      ],
    });
  });

  it('archives a plan through a patch', async () => {
    const { client, calls } = clientWith({ plan: { id: 'plan_1', active: false } });

    await expect(client.updatePlan('plan_1', { active: false })).resolves.toEqual({
      id: 'plan_1',
      active: false,
    });

    expect(calls[0]?.[0]).toBe('http://api.test/plans/plan_1');
    expect(calls[0]?.[1]?.method).toBe('PATCH');
    expect(bodyOf(calls)).toEqual({ active: false });
  });

  // A delete answers 204 with no body at all, which must decode to
  // undefined rather than throwing inside JSON.parse.
  it('deletes a plan and tolerates the empty 204 body', async () => {
    const { client, calls } = clientWith(undefined, { status: 204, text: '' });

    await expect(client.deletePlan('plan_1')).resolves.toBeUndefined();
    expect(calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('filters plans by product and active state', async () => {
    const { client, calls } = clientWith({ plans: [] });

    await client.listPlans({ productId: 'prod_1', active: true });

    expect(calls[0]?.[0]).toBe('http://api.test/plans?productId=prod_1&active=true');
  });

  it('reads and updates a product', async () => {
    const { client, calls } = clientWith({ product: { id: 'prod_1', name: 'API access' } });

    await expect(client.getProduct('prod_1')).resolves.toEqual({
      id: 'prod_1',
      name: 'API access',
    });
    expect(calls[0]?.[0]).toBe('http://api.test/products/prod_1');

    await client.updateProduct('prod_1', { active: false });
    expect(calls[1]?.[1]?.method).toBe('PATCH');
    expect(bodyOf(calls, 1)).toEqual({ active: false });
  });

  it('updates a customer and unwraps the envelope', async () => {
    const { client, calls } = clientWith({ customer: { id: 'cus_1', name: 'Ada' } });

    await expect(client.updateCustomer('cus_1', { name: 'Ada' })).resolves.toEqual({
      id: 'cus_1',
      name: 'Ada',
    });
    expect(calls[0]?.[0]).toBe('http://api.test/customers/cus_1');
  });

  // Clearing a VAT id is a null, not an omitted field: leaving it out would
  // mean "don't change it", which is the opposite of what was asked.
  it('sends an explicit null to clear a nullable customer field', async () => {
    const { client, calls } = clientWith({ customer: { id: 'cus_1' } });

    await client.updateCustomer('cus_1', { taxId: null, country: null });

    expect(bodyOf(calls)).toEqual({ taxId: null, country: null });
  });

  it('deletes a customer', async () => {
    const { client, calls } = clientWith(undefined, { status: 204, text: '' });

    await expect(client.deleteCustomer('cus_1')).resolves.toBeUndefined();
    expect(calls[0]?.[0]).toBe('http://api.test/customers/cus_1');
    expect(calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('surfaces a duplicate email as a conflict', async () => {
    const { client } = clientWith(
      { error: { code: 'CONFLICT', message: 'A customer with this email already exists' } },
      { status: 409 },
    );

    const error = (await client
      .createCustomer({ name: 'Ada', email: 'ada@test.com' })
      .catch((err: unknown) => err)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('CONFLICT');
  });
});
