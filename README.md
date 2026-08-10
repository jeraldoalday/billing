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

This project is being built incrementally, day by day:

1. Repo scaffolding, tooling, Express skeleton, Prisma init *(done)*
2. Auth: signup/login, JWT, org-scoped tenancy
3. Products, plans, and pricing models (flat/tiered/usage-based)
4. Customers and subscription lifecycle (create/upgrade/downgrade/cancel/trial, proration)
5. Invoicing engine (line items, tax, numbering, status state machine)
6. Payments via a mock gateway abstraction, retries
7. Usage-based billing / metering
8. Dunning (failed-payment retry) and outbound webhooks
9. Coupons/discounts, refined tax rules, MRR/churn/ARPU reporting
10. Background jobs: recurring billing runner
11. Frontend: scaffold, auth pages
12. Frontend: dashboard, customers, plans UI
13. Frontend: subscriptions, invoices, settings UI
14. Integration tests, docs, polish

## License

Unlicensed — personal project.
