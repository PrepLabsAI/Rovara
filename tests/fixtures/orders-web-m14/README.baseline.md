# Orders web fixture

A small Node HTTP application for exercising browser and API checks. It has no runtime dependencies.

## The orders page

`GET /` serves a single page with:

- a sign-in form (email, password) and a signed-in identity line (display name and role);
- the signed-in tenant's orders table, one row per order, with an inventory column;
- an owner-only button that downloads the tenant's orders as a CSV file (viewers do not see it);
- an orders state panel and an access-error line.

## API

- `GET /health` returns `{"status":"ready"}`.
- `POST /api/login`, `POST /api/logout` manage a cookie session.
- `GET /api/me` returns the signed-in subject, tenant, role and display name.
- `GET /api/orders/state` returns the orders state record.
- `GET /api/tenants/:tenantId/orders` lists that tenant's orders with their inventory status; other tenants are refused with 403.
- `GET /api/orders.csv?from&to` (owners only, others get 403) downloads the tenant's orders as CSV with the columns `id,customer,total,state,inventory`. `from` and `to` are optional `YYYY-MM-DD` dates. Cells that start with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with a quote.
- `GET /api/inventory/status` checks the inventory dependency health.

## Inventory

`inventory/openapi.json` describes the one inventory operation the application calls: `GET /v1/stock?orderId=<id>` (`200 { status: "in-stock" | "low" | "out" }`, `404 { error }`). The application reads the service address from `INVENTORY_ORIGIN`; any answer that is not a well-formed stock status shows as `unavailable`. `e2e/mocks/inventory-v1.json` is a mock of that service.

## Running

```sh
node --test
ORDERS_TEST_SEED_FILE=.owned/seed.json INVENTORY_ORIGIN=http://localhost:4400 APP_PORT=4317 node server.mjs
```

## Seed

The repository contains no accounts or passwords. The account seed is supplied at runtime through the `ORDERS_TEST_SEED_FILE` environment variable, which must point to a JSON file under `.owned/` in the application directory. Never commit `.owned/` (it is in `.gitignore`).

Minimal seed shape (placeholder values, `passwordDigest` is the sha256 hex of the password):

```json
{
  "accounts": [
    {
      "email": "kzr41@a.example",
      "passwordDigest": "0000000000000000000000000000000000000000000000000000000000000000",
      "subjectId": "subject-1",
      "tenantId": "tenant-a",
      "role": "owner",
      "displayName": "Owner A"
    }
  ]
}
```

The tests in `test/` build the application with their own in-test seed.
