# Orders web fixture

A small Node HTTP application for exercising browser and API checks. It has no runtime dependencies.

## The orders page

`GET /` serves a single page with:

- a sign-in form (email, password) and a signed-in identity line (display name and role);
- the signed-in tenant's orders table, one row per order, with an inventory column;
- an owner-only button that downloads the tenant's orders as a CSV file (viewers do not see it);
- an access-error line.

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
ROVARA_ACCOUNTS_FILE=accounts.json ROVARA_DATA_DIR=.owned node scripts/seed.mjs
ROVARA_DATA_DIR=.owned INVENTORY_ORIGIN=http://localhost:4400 APP_PORT=4317 node server.mjs
```

## Accounts

The repository contains no accounts or passwords. `scripts/seed.mjs` builds the application's user records at run time. It reads the accounts file named by `ROVARA_ACCOUNTS_FILE`, writes `users.json` to the directory named by `ROVARA_DATA_DIR`, and stores only a sha256 digest of each password. The application reads those records when it starts. Never commit `.owned/` (it is in `.gitignore`).

Accounts file shape (placeholder values):

```json
{
  "schemaVersion": "rovara-accounts/v1",
  "accounts": [
    { "profileId": "orders-owner", "email": "kzr41@a.example", "password": "change-me", "tenantRef": "tenant-a", "roleRef": "owner" }
  ]
}
```

The tests in `test/` build the application with their own in-test accounts.
