## What changed

<!-- A short description of the change and why it's needed. Link any related issue, e.g. "Closes #12". -->

## How it was tested

<!-- Tests added or updated, and anything you checked by hand. -->

## Checklist

- [ ] `npx tsc --noEmit` passes in `server/` (and `web/` if touched)
- [ ] `npx eslint .` passes
- [ ] Tests pass and new behavior has tests
- [ ] New queries are scoped by `organizationId`
- [ ] Prisma migration committed (if the schema changed)
