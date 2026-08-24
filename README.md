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
    domain/     Pure rules: pricing, proration, tax, dunning, billing cycle
    lib/        Shared infrastructure (Prisma client, logger, job queue)
    middleware/ Express middleware (error handling, auth)
    routes/     HTTP route handlers
    services/   Domain/business logic
    utils/      Small stateless helpers
    index.ts    HTTP server entry point
    worker.ts   Background worker entry point
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

The background worker is a separate process (see **Background jobs** below):

```bash
npm run dev:worker
```

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

## Coupons and discounts

A coupon is a percentage or a fixed amount off, redeemed against one subscription and
applied by the invoicing engine every time it generates an invoice for it. `duration`
decides how long a single redemption keeps discounting: `ONCE` (the next invoice only),
`REPEATING` with `durationInMonths`, or `FOREVER`. A subscription holds at most one
active coupon at a time — stacking would make the order they apply in matter, and
nothing in the API expresses that order.

```
POST   /coupons                        create a coupon (PERCENT_OFF or AMOUNT_OFF)
GET    /coupons                        list coupons (filter by active/code/duration)
GET    /coupons/redemptions            the redemption log (filter by status/coupon/subscription)
PATCH  /coupons/:id                    change name/limit/expiry/active — never the discount itself
DELETE /coupons/:id                    only if it has never been redeemed; otherwise deactivate it
POST   /subscriptions/:id/coupon       redeem a coupon by code against a subscription
GET    /subscriptions/:id/coupon       the coupon currently discounting it, if any
DELETE /subscriptions/:id/coupon       detach it
```

An invoice records the discount three ways: a negative `DISCOUNT` line item for display,
a positive `discountAmount` for reporting, and the resulting `total`. The amounts compose
as `total = subtotal - discountAmount + taxAmount`, so tax follows the price actually
charged rather than the list price. An invoice a coupon takes to zero is settled without
ever reaching the payment gateway — processors reject zero-value authorizations, and
sending one would leave a paid-up invoice open for dunning to retry forever.

## Tax treatment

`taxAmount` comes from a flat per-country rate table, applied to the discounted amount,
with two exceptions that change the answer often enough to matter:

- A customer with `taxExempt` set is charged nothing, whatever their country.
- An EU business — one in a member state that has given us a `taxId` matching its
  country — is reverse-charged at 0% and accounts for the VAT itself. An EU consumer
  with no VAT ID pays their own country's rate.

`resolveTaxTreatment` in `server/src/domain/tax.ts` reports which rule applied
(`STANDARD`, `EXEMPT`, `REVERSE_CHARGE`, `NO_JURISDICTION`), so a zero-tax invoice can
say *which* zero it is. The rates are illustrative approximations of each country's
standard VAT/GST rate, not tax advice.

## Reporting

```
GET /reports/mrr?groupBy=plan|interval|currency   monthly recurring revenue, with a breakdown
GET /reports/arpu                                 revenue per paying customer
GET /reports/churn?from=&to=                      subscription and customer churn over a window
GET /reports/revenue?from=&to=                    collected revenue, discounts, tax, outstanding
GET /reports/summary?from=&to=                    all of the above in one request
```

Every figure is derived from the same subscription, invoice and coupon rows the platform
bills from — nothing is stored or cached, so a report can't drift from what was actually
charged. A few decisions worth knowing when reading the numbers:

- **MRR** counts `ACTIVE` and `PAST_DUE` subscriptions on flat plans, normalized onto a
  monthly basis, net of any coupon still discounting them. Trials aren't paying yet, and
  metered plans have no committed recurring amount to report, so neither contributes.
  A past-due subscription still counts: dunning exists to recover it, and dropping it
  would make a declined card look like churn.
- **Churn** is measured against the cohort that was live when the window opened.
  Anything that both started and ended inside the window is in neither figure. Customer
  churn is reported separately from subscription churn, so a customer who swaps one plan
  for another doesn't read as a lost relationship.
- **Revenue** windows on `paidAt`, since revenue is recognized when it's collected, and
  `netRevenue` excludes tax, which is owed onward rather than earned.
- MRR and ARPU are live snapshots with no `asOf`: reconstructing a past instant would
  need history this schema doesn't keep, and a figure that quietly answered a different
  question than it was asked would be worse than not offering one.

## Background jobs

Billing happens on its own, without anyone calling an endpoint. `server/src/worker.ts`
is a second entry point beside the HTTP server, made of two deliberately separate
halves: a **scheduler** that decides when each recurring sweep is due and does nothing
but queue it, and an in-process **job queue** that runs the queued work under a
concurrency limit with a retry budget. That split is what keeps a slow billing run from
delaying the dunning schedule, and what lets a failed sweep retry on its own backoff
instead of waiting a whole interval.

```bash
npm run dev:worker          # watch mode
npm run worker --workspace server -- --once   # one pass, then exit (for cron)
```

| Job | Default interval | What it does |
| --- | --- | --- |
| `billing.cycle` | 15 minutes | Invoices and collects every subscription whose period has closed |
| `dunning.sweep` | 15 minutes | Runs every failed-payment retry that has come due |
| `webhook.retry` | 1 minute | Re-sends every webhook delivery whose retry has come due |

Intervals, the poll resolution and the worker's concurrency are environment variables
(`WORKER_BILLING_INTERVAL_MS`, `WORKER_TICK_MS`, `WORKER_CONCURRENCY`, ... — see
`server/.env.example`). The queue is in-process on purpose: every job is a sweep over
rows that are already durable, so a run lost with the process is re-derived by the next
tick rather than being work that vanished. That does mean **one worker process** per
database — two would each queue their own copy of every sweep. They could not
double-bill (invoice generation refuses a second invoice for the same period, and a
dunning campaign is unique per invoice), but they would do the work twice.

Every execution is recorded as a `JobRun` row — payload, attempts, the summary the
handler returned — which is what makes "did last night's billing run finish, and what
did it charge" answerable after a restart.

```
GET  /jobs                    the run history (filter by name/status)
GET  /jobs/:id                one run
GET  /jobs/queue              what this process can run and what it is holding
POST /jobs                    queue a sweep (202)
POST /jobs/run                run this organization's due jobs now
POST /jobs/billing-run        run a billing cycle synchronously and return the summary
```

### What a billing cycle does

For each subscription that might have work due, the runner asks
`server/src/domain/billingCycle.ts` what should happen and then does it:

- **Renew** — the period has closed, so it is invoiced, finalized and charged, and the
  subscription rolls into the next period. Billing is **in arrears**: an invoice covers
  the period that has *finished*, which is the only way a metered plan's usage can be on
  it. The next period's bounds come from the last period's end, never from the clock, so
  a run that happens late never shifts a billing anniversary.
- **End a trial** — the trial ran out, so the subscription starts paying from the
  scheduled `trialEnd` (not from whenever the worker noticed). Nothing is invoiced: the
  first paid period is billed when it ends, like every other period.
- **Apply a scheduled cancellation** — a cancellation booked for period end has come
  due. The final period is invoiced first, then the subscription stops; `cancelAt` keeps
  the date the customer was told.
- **Skip** — with a reason (`period_not_ended`, `trial_in_progress`, `awaiting_payment`,
  `already_canceled`), so "nothing happened" is never silent.

A declined charge is not an error: the payment is recorded, a dunning campaign opens,
and the subscription goes `PAST_DUE`. The runner then leaves it alone —
stacking a second invoice on a customer who hasn't paid the first would double what
dunning is retrying. When dunning recovers the subscription, the next run bills every
period that elapsed meanwhile, one invoice at a time. A customer with no card on file
is treated the same way as a decline: the invoice stays open and goes into dunning
rather than the debt sitting unnoticed. A period with nothing left to collect (a
100%-off coupon, or proration credits that cancel the charge out) is settled directly,
without the gateway.

`POST /jobs/billing-run` accepts an `asOf`, so a cycle measured in months can be
exercised — or previewed — without waiting months.

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
- [x] Day 8: Dunning (failed-payment retry) and outbound webhooks
- [x] Day 9: Coupons/discounts, refined tax rules, MRR/churn/ARPU reporting
- [ ] Day 10: Background jobs: recurring billing runner
- [ ] Day 11: Frontend: scaffold, auth pages
- [ ] Day 12: Frontend: dashboard, customers, plans UI
- [ ] Day 13: Frontend: subscriptions, invoices, settings UI
- [ ] Day 14: Integration tests, docs, polish

## License

Unlicensed — personal project.
