# Orders web fixture

A small Node HTTP application used by Rovara to exercise browser and API checks. It has no runtime dependencies.

## The orders page

`GET /` serves a single page with:

- a sign-in form (email, password) and a signed-in identity line;
- an orders state panel that shows the result of `GET /api/orders/state` after sign-in;
- an access-error line shown when sign-in is refused.

## API

- `GET /health` returns `{"status":"ready"}`.
- `POST /api/login`, `POST /api/logout` manage a cookie session.
- `GET /api/me` returns the signed-in subject, tenant and role.
- `GET /api/orders/state` returns the orders state record.
- `GET /api/tenants/:tenantId/orders` lists that tenant's orders; other tenants are refused with 403.
- `GET /api/inventory/status` checks the inventory dependency health.

## Running

```sh
APP_PORT=4317 node server.mjs
node --test
```

## Seed

The repository contains no accounts or passwords. Rovara supplies the account seed at runtime through the `ORDERS_TEST_SEED_FILE` environment variable, which must point to a JSON file under `.owned/` in the application directory:

```json
{ "accounts": [{ "email": "...", "passwordDigest": "<sha256 hex of the password>", "subjectId": "...", "tenantId": "tenant-a", "role": "owner", "displayName": "..." }] }
```

The tests in `test/` build the application with their own in-test seed.
