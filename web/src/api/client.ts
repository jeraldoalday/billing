import type {
  ApiErrorBody,
  AuthResult,
  ChurnReport,
  Customer,
  Invoice,
  MrrReport,
  Payment,
  PaymentMethod,
  Plan,
  Product,
  RevenueReport,
  Session,
  Subscription,
  SubscriptionStatus,
  SummaryReport,
  ValidationErrorDetails,
} from './types';

/**
 * A typed wrapper around the billing API.
 *
 * Everything the UI does goes through one `request()` so that four
 * concerns are handled in exactly one place: attaching the bearer token,
 * turning a non-2xx response into a thrown `ApiError`, decoding an empty
 * 204 body without choking on it, and reporting a dead server as something
 * more useful than `TypeError: Failed to fetch`.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when the token is missing, expired, or belongs to a deleted user. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /**
   * Per-field messages from a 400 VALIDATION_ERROR, so a form can show the
   * server's complaint next to the input that caused it. Empty for every
   * other kind of failure.
   */
  get fieldErrors(): Record<string, string[] | undefined> {
    if (this.code !== 'VALIDATION_ERROR') {
      return {};
    }
    const details = this.details as Partial<ValidationErrorDetails> | undefined;
    return details?.fieldErrors ?? {};
  }
}

/** Values a query string can carry; `undefined` and `null` are dropped. */
export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  baseUrl: string;
  /**
   * Read at call time rather than captured once, so a login later in the
   * session is picked up without rebuilding the client.
   */
  getToken?: () => string | null;
  /**
   * Called whenever the API rejects the current token. The auth context
   * uses this to drop the stored session and bounce back to /login.
   */
  onUnauthorized?: () => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Serializes query parameters, skipping absent ones so that
 * `{ active: undefined }` produces no `?active=` the server would then have
 * to reject as an invalid enum.
 */
export function buildQueryString(query: QueryParams | undefined): string {
  if (!query) {
    return '';
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params.set(key, String(value));
  }

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

/** Joins a base URL and a path with exactly one slash between them. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.getToken = options.getToken ?? (() => null);
    this.onUnauthorized = options.onUnauthorized;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };

    const token = this.getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const url = joinUrl(this.baseUrl, path) + buildQueryString(options.query);

    let response: Response;
    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        init.body = body;
      }
      if (options.signal) {
        init.signal = options.signal;
      }
      response = await this.fetchImpl(url, init);
    } catch (cause) {
      // An aborted request is the caller's own doing (a component unmounted,
      // a search box moved on) — surface it unchanged so it can be ignored
      // rather than shown to the user as a server outage.
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        throw cause;
      }
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the billing API', cause);
    }

    if (response.status === 401) {
      this.onUnauthorized?.();
    }

    // 204 No Content (a delete) and any empty body decode to undefined
    // rather than blowing up in JSON.parse.
    const text = await response.text();
    const payload: unknown = text ? safeParseJson(text) : undefined;

    if (!response.ok) {
      throw toApiError(response.status, payload);
    }

    return payload as T;
  }

  get<T>(path: string, query?: QueryParams, signal?: AbortSignal): Promise<T> {
    const options: RequestOptions = { method: 'GET' };
    if (query) options.query = query;
    if (signal) options.signal = signal;
    return this.request<T>(path, options);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  // --- Auth -------------------------------------------------------------

  signup(input: {
    organizationName: string;
    email: string;
    password: string;
    name?: string;
  }): Promise<AuthResult> {
    return this.post<AuthResult>('/auth/signup', input);
  }

  login(input: { email: string; password: string }): Promise<AuthResult> {
    return this.post<AuthResult>('/auth/login', input);
  }

  me(signal?: AbortSignal): Promise<Session> {
    return this.get<Session>('/auth/me', undefined, signal);
  }

  updateProfile(input: {
    name?: string;
    currentPassword?: string;
    newPassword?: string;
  }): Promise<{ user: Session['user'] }> {
    return this.patch<{ user: Session['user'] }>('/auth/me', input);
  }

  // --- Catalogue --------------------------------------------------------

  listProducts(query?: { active?: boolean }): Promise<Product[]> {
    return this.get<{ products: Product[] }>('/products', query).then((r) => r.products);
  }

  createProduct(input: { name: string; description?: string }): Promise<Product> {
    return this.post<{ product: Product }>('/products', input).then((r) => r.product);
  }

  listPlans(query?: { productId?: string; active?: boolean }): Promise<Plan[]> {
    return this.get<{ plans: Plan[] }>('/plans', query).then((r) => r.plans);
  }

  getPlan(id: string): Promise<Plan> {
    return this.get<{ plan: Plan }>(`/plans/${id}`).then((r) => r.plan);
  }

  // --- Customers --------------------------------------------------------

  listCustomers(query?: { active?: boolean; email?: string }): Promise<Customer[]> {
    return this.get<{ customers: Customer[] }>('/customers', query).then((r) => r.customers);
  }

  getCustomer(id: string): Promise<Customer> {
    return this.get<{ customer: Customer }>(`/customers/${id}`).then((r) => r.customer);
  }

  createCustomer(input: {
    name: string;
    email: string;
    country?: string;
    taxId?: string;
    taxExempt?: boolean;
  }): Promise<Customer> {
    return this.post<{ customer: Customer }>('/customers', input).then((r) => r.customer);
  }

  // --- Subscriptions ----------------------------------------------------

  listSubscriptions(query?: {
    customerId?: string;
    status?: SubscriptionStatus;
  }): Promise<Subscription[]> {
    return this.get<{ subscriptions: Subscription[] }>('/subscriptions', query).then(
      (r) => r.subscriptions,
    );
  }

  getSubscription(id: string): Promise<Subscription> {
    return this.get<{ subscription: Subscription }>(`/subscriptions/${id}`).then(
      (r) => r.subscription,
    );
  }

  createSubscription(input: {
    customerId: string;
    planId: string;
    trialDays?: number;
  }): Promise<Subscription> {
    return this.post<{ subscription: Subscription }>('/subscriptions', input).then(
      (r) => r.subscription,
    );
  }

  cancelSubscription(id: string, atPeriodEnd = false): Promise<Subscription> {
    return this.post<{ subscription: Subscription }>(`/subscriptions/${id}/cancel`, {
      atPeriodEnd,
    }).then((r) => r.subscription);
  }

  changeSubscriptionPlan(id: string, planId: string): Promise<{ subscription: Subscription }> {
    return this.patch<{ subscription: Subscription }>(`/subscriptions/${id}/plan`, { planId });
  }

  // --- Invoices and payments -------------------------------------------

  listInvoices(query?: {
    customerId?: string;
    subscriptionId?: string;
    status?: string;
  }): Promise<Invoice[]> {
    return this.get<{ invoices: Invoice[] }>('/invoices', query).then((r) => r.invoices);
  }

  getInvoice(id: string): Promise<Invoice> {
    return this.get<{ invoice: Invoice }>(`/invoices/${id}`).then((r) => r.invoice);
  }

  finalizeInvoice(id: string): Promise<Invoice> {
    return this.post<{ invoice: Invoice }>(`/invoices/${id}/finalize`).then((r) => r.invoice);
  }

  voidInvoice(id: string): Promise<Invoice> {
    return this.post<{ invoice: Invoice }>(`/invoices/${id}/void`).then((r) => r.invoice);
  }

  listInvoicePayments(id: string): Promise<Payment[]> {
    return this.get<{ payments: Payment[] }>(`/invoices/${id}/payments`).then((r) => r.payments);
  }

  listPaymentMethods(query?: { customerId?: string }): Promise<PaymentMethod[]> {
    return this.get<{ paymentMethods: PaymentMethod[] }>('/payment-methods', query).then(
      (r) => r.paymentMethods,
    );
  }

  // --- Reporting --------------------------------------------------------

  getMrrReport(query?: { groupBy?: 'plan' | 'interval' }): Promise<MrrReport> {
    return this.get<MrrReport>('/reports/mrr', query);
  }

  getChurnReport(query?: { from?: string; to?: string }): Promise<ChurnReport> {
    return this.get<ChurnReport>('/reports/churn', query);
  }

  getRevenueReport(query?: { from?: string; to?: string }): Promise<RevenueReport> {
    return this.get<RevenueReport>('/reports/revenue', query);
  }

  getSummaryReport(query?: { from?: string; to?: string }): Promise<SummaryReport> {
    return this.get<SummaryReport>('/reports/summary', query);
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A proxy or a crashed process can answer with HTML. Keep the raw text
    // so the thrown error can still say something specific.
    return { raw: text };
  }
}

function toApiError(status: number, payload: unknown): ApiError {
  const body = payload as Partial<ApiErrorBody> | undefined;
  const error = body?.error;

  if (error && typeof error.message === 'string') {
    return new ApiError(status, error.code ?? 'ERROR', error.message, error.details);
  }

  return new ApiError(status, 'ERROR', `Request failed with status ${status}`, payload);
}

/**
 * The API origin, from `VITE_API_BASE_URL`. Falls back to the port the
 * server listens on by default so `npm run dev` works with no .env file.
 */
export function resolveApiBaseUrl(env: Record<string, string | undefined>): string {
  const configured = env.VITE_API_BASE_URL?.trim();
  return configured && configured.length > 0 ? configured : 'http://localhost:4000';
}
