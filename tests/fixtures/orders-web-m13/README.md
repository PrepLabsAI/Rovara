# Orders web fixture

A small Node HTTP application for exercising browser and API checks. It has no runtime dependencies.

## The orders page

`GET /` serves a single page with:

- a sign-in form (`email`, `password`, `login-submit`) and a signed-in identity line (`identity`: display name and role; the account email is never rendered). After a sign-in the form is cleared and hidden;
- the signed-in tenant's orders table (`orders-table`), one row per order (`order-row-<id>`), with the columns order, customer, total and state;
- an export button (`export-csv`) that downloads the tenant's orders as a CSV file, with a status line (`orders-export-status`);
- an orders state panel and an access-error line (`orders-access-error`).

## API

- `GET /health` returns `{"status":"ready"}`.
- `POST /api/login`, `POST /api/logout` manage a cookie session.
- `GET /api/me` returns the signed-in `subjectId`, `tenantId` and `role` (and the display name).
- `GET /api/orders/state` returns the orders state record.
- `GET /api/tenants/:tenantId/orders` lists that tenant's orders; other tenants are refused with 403.
- `GET /api/orders.csv?from&to` downloads the signed-in tenant's orders as CSV with the columns `id,customer,total,state`. `from` and `to` are optional `YYYY-MM-DD` dates. Cells that start with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with a quote, and cells with a separator are quoted.
- `GET /api/inventory/status` checks the inventory service.

## Export access

Every signed-in account sees the export button and can download the export, viewers included. The export is not limited by role.

## Inventory service

`inventory/openapi.json` describes the one operation of the inventory service: `GET /v1/stock?orderId=<id>` (`200 { status: "in-stock" | "low" | "out" }`, `404 { error }`). The application reads the service address from `INVENTORY_ORIGIN`; the orders table and the export do not use it yet. `e2e/mocks/inventory-v1.json` is a mock of that service (`a1` in stock, `a2` unknown, `b1` malformed).

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
