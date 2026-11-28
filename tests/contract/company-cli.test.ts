// #1613: `company show` and `company rename` against a scripted broker: what is sent, what is printed, and the server's refusals in its own words.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NOT_IN_A_COMPANY_MESSAGE } from "@agentx/contracts";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { COMPANY_RENAME_ADMIN_ONLY } from "../../packages/broker/src/aws/company-details-routes.js";

const ORIGIN = "http://127.0.0.1:4411";
const ISSUER = `${ORIGIN}/v1/auth`;
const COMPANY = "org_" + "a".repeat(20);
const entry = { url: ORIGIN, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

type Script = (call: { method: string; path: string; body: Record<string, unknown> | undefined }) => { status?: number; body: Record<string, unknown> };

async function cli(script: Script) {
  const home = await mkdtemp(join(tmpdir(), "rovara-company-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "laptop", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "local-owner-token", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [], err: string[] = [];
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const call = { method: init?.method ?? "GET", path: target.pathname, body };
    calls.push(call);
    const reply = script(call);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const run = (argv: string[]) => executeCli(["--env", "laptop", ...argv], { fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } });
  return { run, text: () => out.join(""), errors: () => err.join(""), calls };
}

describe("rovara company", () => {
  it("show prints the company's name, ID, your role and how many members it has", async () => {
    const h = await cli(() => ({ body: { companyId: COMPANY, name: "acme-install", role: "admin", members: 3 } }));
    expect(await h.run(["company", "show"]), h.errors()).toBe(0);
    expect(h.calls).toEqual([{ method: "GET", path: "/v1/dev/company/details", body: undefined }]);
    expect(h.text()).toBe(`Company: acme-install\n  ID: ${COMPANY}\n  Your role: administrator\n  Members: 3 members\n`);
  });

  it("show --json prints the server's answer", async () => {
    const h = await cli(() => ({ body: { companyId: COMPANY, name: "acme-install", role: "owner", members: 1 } }));
    expect(await h.run(["--json", "company", "show"]), h.errors()).toBe(0);
    expect(JSON.parse(h.text())).toMatchObject({ ok: true, data: { companyId: COMPANY, name: "acme-install", role: "owner", members: 1 } });
  });

  it("show tells a person in no company so, in the server's words, never that their sign-in ended", async () => {
    const h = await cli(() => ({ status: 403, body: { error: { code: "FORBIDDEN", message: NOT_IN_A_COMPANY_MESSAGE } } }));
    expect(await h.run(["company", "show"])).not.toBe(0);
    expect(h.errors()).toContain(NOT_IN_A_COMPANY_MESSAGE);
    expect(h.errors()).not.toMatch(/sign-in .*ended/u);
  });

  it("rename sends the new name and prints the renamed company", async () => {
    const h = await cli(({ body }) => ({ body: { companyId: COMPANY, name: body?.["name"], role: "owner", members: 2 } }));
    expect(await h.run(["company", "rename", "  Acme Corp "]), h.errors()).toBe(0);
    expect(h.calls).toEqual([{ method: "PUT", path: "/v1/dev/company/details", body: { name: "Acme Corp" } }]);
    expect(h.text()).toContain("Renamed your company to Acme Corp.\nCompany: Acme Corp\n");
  });

  it("rename refuses a name the server would refuse before sending anything", async () => {
    const h = await cli(() => ({ body: {} }));
    for (const name of ["   ", "x".repeat(81)]) expect(await h.run(["company", "rename", name])).not.toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.errors()).toContain("1 to 80 characters");
  });

  it("rename shows why a plain member is refused", async () => {
    const h = await cli(() => ({ status: 403, body: { error: { code: "FORBIDDEN", message: COMPANY_RENAME_ADMIN_ONLY } } }));
    expect(await h.run(["company", "rename", "Acme Corp"])).not.toBe(0);
    expect(h.errors()).toContain(COMPANY_RENAME_ADMIN_ONLY);
  });
});
