# Billing Platform

A subscription billing platform: customers, pricing plans, subscriptions, invoice
generation, payments, usage-based metering, dunning, coupons, webhooks, and revenue
reporting (MRR/churn/ARPU).

## Stack

- **Server**: Node.js, TypeScript, Express, Prisma (SQLite for local dev), Zod, Pino
- **Web** (coming later): React, Vite, TypeScript, Tailwind
- **Tests**: Vitest + Supertest

## Project layout

```
server/         Express API, domain logic, Prisma schema/migrations
  src/
    config/     Environment loading and validation
    lib/        Shared infrastructure (Prisma client, logger)
    middleware/ Express middleware (error handling, auth once added)
    routes/     HTTP route handlers
    services/   Domain/business logic
    utils/      Small stateless helpers
  prisma/       Schema and migrations
web/            React frontend (added later in the roadmap)
```

## Getting started

```bash
npm install
cp server/.env.example server/.env
npm run dev:server
```

The server starts on `http://localhost:4000`. `GET /health` returns a basic liveness
check.

Run the server's tests:

```bash
npm run test:server
```

## Dunning and webhooks

A charge that is declined (`POST /invoices/:id/charge`) opens a **dunning campaign**
for that invoice and moves the subscription to `PAST_DUE`. The campaign retries the
customer's default card 1, 3 and 7 days after the first failure; if the last retry
still fails, the subscription is canceled and the invoice is left open, since the
amount is still owed. Settling the invoice at any point — a successful retry, a charge
with a different card, or marking it paid administratively — closes the campaign and
returns the subscription to `ACTIVE`.

```
POST /dunning/run             run every retry that is due (accepts `asOf` to simulate a later date)
GET  /dunning                 list campaigns (filter by status/subscriptionId/invoiceId)
GET  /dunning/:id             a campaign with its invoice, subscription, and attempt history
POST /dunning/:id/retry       retry now, ignoring the schedule
POST /dunning/:id/cancel      call off a campaign settled outside the system
```

Domain events (`invoice.*`, `payment.*`, `subscription.*`, `dunning.*`) are delivered
to the endpoints an organization registers. An endpoint subscribes with exact event
types, a namespace wildcard (`invoice.*`), or `*`.

```
POST   /webhook-endpoints                  register an endpoint (returns the signing secret once)
GET    /webhook-endpoints                  list endpoints (secrets masked)
PATCH  /webhook-endpoints/:id              change url/description/subscriptions/active
POST   /webhook-endpoints/:id/rotate-secret
DELETE /webhook-endpoints/:id
GET    /webhook-deliveries                 the delivery log (filter by endpoint/type/status)
POST   /webhook-deliveries/:id/redeliver   send a copy of a past event
POST   /webhook-deliveries/retry-due       run every delivery retry that is due
```

Each request carries a `webhook-signature` header of the form `t=<unix>,v1=<hmac>`,
where the HMAC-SHA256 is taken over `"<t>.<raw body>"` with the endpoint's secret.
Verify it against the raw body before parsing, and reject timestamps outside a few
minutes of your clock — `verifyWebhookSignature` in `server/src/domain/webhook.ts` is
the reference implementation. Failed deliveries are retried up to five times with
exponential backoff.

## Roadmap

This project is being built incrementally, one day of work at a time. Each checked box
below represents a day that has been fully implemented (typechecked, linted, tested,
and pushed to `main`). This list is the source of truth for what's done and what's
next — including for the automated daily build (see `AGENT.md`).

- [x] Day 1: Repo scaffolding, tooling, Express skeleton, Prisma init
- [x] Day 2: Auth (signup/login, JWT, org-scoped tenancy, profile update)
- [x] Day 3: Products, plans, and pricing models (flat/tiered/usage-based)
- [x] Day 4: Customers and subscription lifecycle (create/upgrade/downgrade/cancel/trial, proration)
- [x] Day 5: Invoicing engine (line items, tax, numbering, status state machine)
- [x] Day 6: Payments via a mock gateway abstraction, retries
- [x] Day 7: Usage-based billing / metering
- [ ] Day 8: Dunning (failed-payment retry) and outbound webhooks
- [ ] Day 9: Coupons/discounts, refined tax rules, MRR/churn/ARPU reporting
- [ ] Day 10: Background jobs: recurring billing runner
- [ ] Day 11: Frontend: scaffold, auth pages
- [ ] Day 12: Frontend: dashboard, customers, plans UI
- [ ] Day 13: Frontend: subscriptions, invoices, settings UI
- [ ] Day 14: Integration tests, docs, polish

## License

Unlicensed — personal project.
