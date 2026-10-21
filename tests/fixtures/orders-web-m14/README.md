# Orders web fixture

A small Node HTTP application used by Rovara to exercise browser and API checks. It has no runtime dependencies.

## Two variants of one application

This directory is the **local Linux fixture** of Rovara M1.4. The same sources also produce the **live baseline** that is published as the `main` branch of the fixture repository.

| | local Linux fixture | live baseline |
| --- | --- | --- |
| Owner download button | `data-testid="download-orders"`, label "Download orders" | `data-testid="export-csv"`, label "Export CSV" |
| Decoy | `data-testid="download-invoices"`, label "Download invoices" (downloads a different CSV from `GET /api/invoices.csv`) | none |
| Used for | Rovara's own tests of the AI browser-test agent, where the button has to be found by its meaning | the live demo, where a coding agent is asked to rename the button |

The live baseline is the reference state after the M1.3 demo: viewers are refused, each tenant sees only its own orders, and the orders table and CSV carry an inventory column. The decoy is not added live, so the demo keeps one clear goal.

The live baseline is generated from this directory by `scripts/fixtures/publish-web-fixture.ts --variant m14`. It renames the button back, removes the decoy markup, the `/api/invoices.csv` route (the lines between the `fixture-variant:local-only` markers in `server.mjs`) and `test/invoices.test.mjs`. It refuses to publish if one of those edits no longer matches exactly once.

## The orders page

`GET /` serves a single page with:

- a sign-in form (email, password) and a signed-in identity line (display name and role; the account email is never rendered);
- the signed-in tenant's orders table (`data-testid="orders-table"`, one `order-row-<id>` per order) with an inventory column;
- the owner-only download buttons described above, hidden for a viewer;
- an orders state panel and an access-error line.

## API

- `GET /health` returns `{"status":"ready"}`.
- `POST /api/login`, `POST /api/logout` manage a cookie session.
- `GET /api/me` returns the signed-in subject, tenant, role and display name.
- `GET /api/orders/state` returns the orders state record.
- `GET /api/tenants/:tenantId/orders` lists that tenant's orders with their inventory status; other tenants are refused with 403.
- `GET /api/orders.csv?from&to` (owner only, viewers get 403) downloads the tenant's orders as CSV: `id,customer,total,state,inventory`. `from` and `to` are optional `YYYY-MM-DD` dates. Cells that start with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with a quote.
- `GET /api/invoices.csv` (owner only; local Linux fixture only) downloads a different CSV: `invoice,customer,amount,status`.
- `GET /api/inventory/status` checks the inventory dependency health.

## Inventory

`inventory/openapi.json` describes the one inventory operation, `GET /v1/stock?orderId=<id>` (`200 { status: "in-stock" | "low" | "out" }`, `404 { error }`). The application reads the service from `INVENTORY_ORIGIN`; any answer that is not a well-formed stock status shows as `unavailable`. `e2e/mocks/inventory-v1.json` is the mock (`a1` in-stock, `a2` unknown, `b1` malformed).

## Running

```sh
node --test
ORDERS_TEST_SEED_FILE=.owned/seed.json INVENTORY_ORIGIN=http://localhost:4400 APP_PORT=4317 node server.mjs
```

## Seed

The repository contains no accounts or passwords. Rovara supplies the account seed at runtime through the `ORDERS_TEST_SEED_FILE` environment variable, which must point to a JSON file under `.owned/` in the application directory. Never commit `.owned/` (it is in `.gitignore`).

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
