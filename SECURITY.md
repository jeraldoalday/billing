# Security Policy

This project handles billing data, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/jeraldoalday/billing/security/advisories/new)
(the **Security** tab → **Report a vulnerability**).

Please include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- the affected commit or version, if known.

You should get an acknowledgement within a few days. Once the issue is confirmed and
fixed, you'll be credited in the advisory unless you prefer otherwise.

## Supported versions

Only the latest commit on `main` receives security fixes.

## Scope

Things worth reporting include cross-organization data access, authentication or
authorization bypasses, injection, webhook signature flaws, and money-calculation
bugs that could be exploited. The bundled `MockPaymentGateway` is a test double and
is not intended to process real payments.
