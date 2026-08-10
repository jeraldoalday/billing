# Daily build agent instructions

This file is read by an automated daily agent that continues building this project.
If you are that agent, follow this exactly.

## 1. Find out what to build

Read the "Roadmap" section in `README.md`. It's a checklist, one box per day. Find the
**first unchecked box**. That is today's scope. If every box is checked, there is
nothing to do — make no changes, no commits, and stop immediately. Do not re-do or
"polish" already-checked days unless a later day's scope explicitly calls for touching
that code again (e.g. Day 4 building on Day 3's models).

## 2. Match existing conventions

Before writing code, skim `server/src/` to see how things are already done, and follow
the same patterns:

- Routes are thin: parse/validate the request with a Zod schema from `src/validators/`,
  call a function in `src/services/`, translate the result to a response. Business
  logic lives in services, not routes.
- Errors go through `ApiError` (`src/middleware/errorHandler.ts`) with the right HTTP
  status — `ApiError.badRequest/unauthorized/forbidden/notFound/conflict`.
- All domain models are scoped to an `Organization`. New tables should have an
  `organizationId` foreign key and be filtered by it in every query — never return or
  mutate another org's data.
- Prisma is SQLite locally. Add new models to `server/prisma/schema.prisma` and run
  `npx prisma migrate dev --name <description>` from `server/` to generate a real
  migration (commit the generated migration folder).
- Tests use Vitest + Supertest. Integration tests that hit the database use the
  dedicated test database (`server/.env.test`, loaded via `vitest.setup.ts`) and clean
  up rows in `beforeEach`/`afterAll`, matching `src/routes/auth.test.ts` and
  `src/services/auth.service.test.ts`. `vitest.config.ts` runs test files serially
  (`fileParallelism: false`) because they share one SQLite file — keep that setting.
- Run `npx tsc --noEmit`, `npx eslint src --ext .ts`, and `npx vitest run` from
  `server/` before every commit. Never commit code that doesn't typecheck, lint clean,
  and pass its tests. No stubs, no `TODO: implement later`, no skipped tests.

## 3. Build the day's scope for real

Implement full, working functionality — not scaffolding. Each day should produce
roughly 1,000+ lines of real first-party code (server logic, validators, tests; or
frontend components once the frontend days start) across a mix of new and edited
files. If a day's scope is naturally smaller, it's fine to also make solid progress
into the next unchecked day rather than pad with filler — but never pad with
unnecessary comments, dead code, or trivial rewording just to inflate line count.

Detailed scope per day (only build the one day you picked in step 1):

- **Day 3 — Products, plans, pricing**: `Product` and `Plan` Prisma models scoped to
  Organization. Plans support flat pricing and tiered/usage-based pricing (a `PricingModel`
  enum or discriminated shape — design it cleanly). CRUD endpoints for products and
  plans with Zod validation, org-scoping enforced, tests for validation errors and
  cross-org isolation.

- **Day 4 — Customers and subscriptions**: `Customer` model. `Subscription` model
  linking a Customer to a Plan with status (trialing/active/past_due/canceled),
  `currentPeriodStart/End`. Endpoints: create/cancel/upgrade/downgrade a subscription,
  start a trial. Proration math as a pure, unit-tested function (e.g. switching plans
  mid-period credits/charges the difference).

- **Day 5 — Invoicing engine**: `Invoice` and `InvoiceLineItem` models. A service that
  generates an invoice from a subscription's current period (plan price + any
  usage/proration line items), sequential invoice numbering per org, a tax calculation
  function (simple rate-table based), and an invoice status state machine
  (draft → open → paid/void). Tests covering the state machine transitions and totals
  math.

- **Day 6 — Payments**: A `PaymentGateway` interface plus a `MockPaymentGateway`
  implementation (simulates success/decline deterministically based on input, e.g. a
  magic card number that always declines — no real network calls). `Payment` model,
  `PaymentMethod` model. Charging an invoice, handling declines, a retry-with-backoff
  helper. Tests for success, decline, and retry paths.

- **Day 7 — Usage-based billing**: `UsageEvent` model (org/customer/subscription
  scoped, metric name, quantity, timestamp). Ingestion endpoint. An aggregation
  function that sums usage over a billing period per metric. Wire metered pricing
  (from Day 3) into invoice generation (Day 5) so usage charges show up as invoice
  line items. Tests for aggregation edge cases (period boundaries, multiple metrics).

- **Day 8 — Dunning and webhooks**: A dunning state machine that schedules retries for
  a `past_due` invoice/subscription (e.g. retry on day 1, 3, 7, then mark the
  subscription canceled). `WebhookEndpoint` and `WebhookDelivery` models. An event
  emitter that fires on key domain events (`invoice.created`, `payment.failed`,
  `subscription.updated`, etc.), signs the payload (HMAC), and records delivery
  attempts with retry-on-failure. Tests for the dunning schedule and webhook signing.

- **Day 9 — Coupons and reporting**: `Coupon` model (percent-off/amount-off,
  duration), applied during invoice generation. Refine the Day 5 tax function if
  needed. Reporting endpoints: MRR, churn rate, ARPU, computed from real subscription/
  invoice data with tests asserting the math against constructed fixtures.

- **Day 10 — Background jobs**: A small job-queue abstraction (in-process is fine —
  no need for Redis) and a worker entry point. A recurring billing job that, for every
  subscription whose period has ended, generates the next invoice and attempts payment
  (using Day 6's gateway), and triggers dunning (Day 8) on failure. Tests run the job
  function directly against fixture data.

- **Day 11 — Frontend scaffold**: `web/` package — Vite + React + TypeScript +
  Tailwind. Router, a typed API client (fetch wrapper) pointed at the server, an auth
  context, and login/signup pages that call the real `/auth/*` endpoints.

- **Day 12 — Frontend dashboard**: Dashboard page with MRR/churn (from Day 9's
  reporting endpoints), customers list/detail pages, plans management UI — all backed
  by real API calls, not mock data.

- **Day 13 — Frontend subscriptions/invoices**: Subscription management UI
  (create/upgrade/cancel), invoices list/detail view, billing settings page.

- **Day 14 — Polish**: End-to-end smoke test(s) covering signup → create plan → add
  customer → subscribe → generate invoice → pay. Fill gaps in test coverage. Update
  `README.md` (setup instructions for the frontend, overall architecture). Fix any bugs
  found. This is the last day — after this day's box is checked, the agent should do
  nothing on subsequent runs (see step 1).

## 4. Commit and push

Commit in atomic, well-scoped commits as you go (roughly 10-15 for the day), following
the existing message style: `type(scope): description` (`feat(server): ...`,
`test(server): ...`, `chore: ...`, `docs: ...`). Do not squash the day into one commit.
As the **last** commit of the day, check the box for today's day in `README.md`'s
roadmap. Push directly to `origin main`. Do not force-push, do not rewrite existing
history, do not open a PR — this project commits straight to `main`.

If you hit a blocker you can't resolve (e.g. a design decision that's genuinely
ambiguous), make the most reasonable choice, document it briefly in a code comment or
the README, and keep going — do not leave the day half-finished without at least a
working, tested state at HEAD.
