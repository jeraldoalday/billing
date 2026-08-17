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
