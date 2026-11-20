import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fixtures = join(import.meta.dirname, "../fixtures");
const read = (directory: string, path: string): string => readFileSync(join(fixtures, directory, path), "utf8");

describe("orders web starter", () => {
  it("has no CSV export route or export button", () => {
    for (const path of ["server.mjs", "public/index.html", "public/app.js"]) {
      const source = read("orders-web-starter", path);
      expect(source, path).not.toContain("/api/orders.csv");
      expect(source, path).not.toContain("download-orders");
      expect(source, path).not.toContain("orders-export-status");
    }
  });

  it("has no injected-defect loading path", () => {
    expect(read("orders-web-starter", "server.mjs")).not.toContain("ORDERS_TEST_DEFECT_FILE");
  });

  it("still serves login, identity, orders list, state, tenants, dependency and health", () => {
    const server = read("orders-web-starter", "server.mjs");
    for (const route of ["/api/login", "/api/logout", "/api/me", "/api/orders/state", "/api/inventory/status", "/health"]) expect(server).toContain(route);
    expect(server).toContain("tenants");
  });

  it("matches the full fixture contract", () => {
    expect(read("orders-web-starter", "package.json")).toBe(read("e2e-web-api-app", "package.json"));
  });
});

describe("full e2e-web-api-app fixture", () => {
  it("still has the CSV export route and export button", () => {
    expect(read("e2e-web-api-app", "server.mjs")).toContain("/api/orders.csv");
    expect(read("e2e-web-api-app", "public/index.html")).toContain('data-testid="download-orders"');
    expect(read("e2e-web-api-app", "public/app.js")).toContain("/api/orders.csv");
  });
});
