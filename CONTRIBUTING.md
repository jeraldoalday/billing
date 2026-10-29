# Contributing

Thanks for your interest in improving the billing platform! Bug reports, fixes,
tests, and docs improvements are all welcome.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Please report security issues privately as described in [SECURITY.md](SECURITY.md),
not in a public issue.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the
  approach before you spend time on it.
- Check the **Roadmap** in [README.md](README.md) — some features are planned and
  may already be in progress.

## Local setup

Requires Node.js 20+.

```bash
npm install
cp server/.env.example server/.env
cd server && npx prisma generate && npx prisma migrate dev && cd ..
npm run dev:server   # API on http://localhost:4000
npm run dev:web      # console on http://localhost:5173
```

See [README.md](README.md) for the worker and the rest of the architecture.

## Checks

CI runs these on every pull request; please run them locally first.

```bash
# server
cd server
npx tsc --noEmit
npm run test:migrate
npx vitest run

# web
cd web
npx tsc -p tsconfig.json --noEmit
npx vitest run

# whole repo (from the root)
npx eslint .
npx prettier --check .
```

## Conventions

- **Routes are thin.** Validate the request with a Zod schema from
  `server/src/validators/`, call a function in `server/src/services/`, and translate
  the result to a response. Business logic lives in services; pure billing rules live
  in `server/src/domain/`.
- **Errors** go through `ApiError` (`server/src/middleware/errorHandler.ts`) with the
  right HTTP status.
- **Tenancy.** Every domain model is scoped to an `Organization`. New tables need an
  `organizationId` foreign key and every query must filter by it — never read or
  mutate another org's data. Add a test for cross-org isolation.
- **Schema changes.** Edit `server/prisma/schema.prisma`, run
  `npx prisma migrate dev --name <description>` from `server/`, and commit the
  generated migration folder.
- **Tests.** New behavior needs tests (Vitest + Supertest on the server, Vitest +
  Testing Library on the web). No skipped tests or stubs.
- **Money math** (proration, tax, discounts, usage) should be pure functions with
  unit tests that cover edge cases.

## Commits and pull requests

- Use the existing commit style: `type(scope): description`, e.g.
  `feat(server): add coupon expiry`, `fix(web): ...`, `test(server): ...`,
  `docs: ...`, `chore: ...`.
- Keep pull requests focused on one change, and describe what changed and how you
  tested it.
- By submitting a contribution, you agree that it is licensed under the
  [MIT License](LICENSE).
