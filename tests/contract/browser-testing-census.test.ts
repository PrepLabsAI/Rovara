// Browser testing in a project's setup (owner decision 421: source-backed, nothing typed): the census of what the feature may touch. Each test reads the SOURCE, so a change that widens the feature fails here first.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBrowserTestingPath } from "../../packages/broker/src/core-host/browser-testing-routes.js";

const SRC = "packages/broker/src";
const read = (path: string): string => readFileSync(join(SRC, path), "utf8");
function files(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(join(SRC, directory), { withFileTypes: true })) {
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) files(path, found); else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}
const browserFiles = ["core/setup-agent/browser-testing.ts", "core/setup-agent/browser-testing-state.ts", "core/setup-agent/browser-testing-proposal.ts", "core/setup-agent/browser-testing-approval.ts",
  "core/setup-agent/browser-testing-renewal.ts", "core/setup-agent/browser-testing-sandbox.ts", "core-host/browser-testing-routes.ts"];

describe("the route family", () => {
  it("is exactly: GET the page; POST refresh, check, decision, discard, pause, resume; PUT draft", () => {
    const base = "/v1/app/projects/payments/browser-testing";
    const allowed = new Set(["GET ", "POST /refresh", "POST /check", "POST /decision", "POST /discard", "POST /pause", "POST /resume", "PUT /draft"]);
    for (const tail of ["", "/refresh", "/check", "/decision", "/discard", "/pause", "/resume", "/draft"]) for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
      expect(isBrowserTestingPath(`${base}${tail}`, method), `${method} ${tail}`).toBe(allowed.has(`${method} ${tail}`));
    }
    // No route takes an account, a password, an address or a secret.
    for (const tail of ["/accounts", "/accounts/viewer", "/password", "/address", "/secret", "/login", "/callback", "/purge"]) for (const method of ["GET", "POST", "PUT", "DELETE"]) expect(isBrowserTestingPath(`${base}${tail}`, method), `${method} ${tail}`).toBe(false);
    expect(isBrowserTestingPath("/v1/app/projects/a/b/browser-testing", "GET")).toBe(false);
  });
});

describe("nothing typed, nothing stored: no secret path in the feature", () => {
  const sources = browserFiles.map((path) => [path, read(path)] as const);

  it("imports no secret store, connector secret, sign-in secret, key or callback module", () => {
    for (const [path, text] of sources) {
      const imports = [...text.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]!);
      for (const specifier of imports) expect(specifier, path).not.toMatch(/secret|connection-secrets|org-connectors|browser-evidence-sign-in|callback|credential|tagged-session|kms/iu);
    }
  });

  it("no body or row schema of the feature has a field that could hold a login", () => {
    for (const [path, text] of sources) {
      const schemas = [...text.matchAll(/z\.object\(\{([\s\S]*?)\}\)\.(?:strict|passthrough)\(\)/gu)].map((match) => match[1]!).join("\n");
      expect(schemas, path).not.toMatch(/\b(password|passwd|secret|token|apiKey|credential|username)\b\s*:/iu);
    }
  });

  it("the page's served view, in every state, has no key that could hold a login, a secret name or a version id", () => {
    const view = read("core/setup-agent/browser-testing.ts");
    const type = view.slice(view.indexOf("export interface BrowserTestingView"), view.indexOf("function summaryOfPolicy"));
    expect(type).not.toMatch(/\b(password|secret|token|credential|arn|versionId)\b/iu);
  });
});

describe("Pause is read only by the planning seam and the page", () => {
  it("the approval, the selection, the round, the authority and the results never read it", () => {
    const allowed = new Set(["core/setup-agent/browser-testing-state.ts", "core/setup-agent/browser-testing.ts", "core/setup-agent/browser-testing-renewal.ts", "aws/core-application-e2e.ts"]);
    const readers = files("").filter((path) => /\breadPaused\b|\bbrowserStateKey\b|E2E_BROWSER_STATE/u.test(read(path)));
    expect(readers.filter((path) => !allowed.has(path))).toEqual([]);
    // The one reader among the engine's seams is the planning context's port, wired in one place.
    expect(read("aws/core-application-e2e.ts")).toContain("paused: async (task) => readPaused(");
    for (const path of files("core/e2e").filter((name) => name !== "core/e2e/application-planning.ts")) expect(read(path), path).not.toMatch(/paused/iu);
    expect(read("core/e2e/application-planning.ts")).toMatch(/ports\.paused/u);
  });
});

describe("accounts are renewed only after a PASSED browser check, after its verdict is committed", () => {
  it("results.ts renews only when the round passed, and only after the commit (the verdict's own fence reads the account rows)", () => {
    const results = read("core/build-step/results.ts");
    expect(results).toContain("passedRound = e2eQualification !== undefined;");
    const commit = results.indexOf("await commitAndContinue(deps, task, next, now, undefined, [], e2eFences);\n  // Browser testing");
    const renew = results.indexOf("await renewAfterPassedRound(deps, { ...task, workflow }, passedRound);");
    expect(results).toContain("passed ? deps.applicationE2E?.accountRenewal?.afterPassedRound(task) : undefined");
    expect(commit).toBeGreaterThan(0);
    expect(renew).toBeGreaterThan(commit);
  });
});

describe("the old admin route keeps refusing a company's e2e registration", () => {
  it("broker.ts still refuses a named company's e2e policy or setup approval, and its words point to the Browser testing page", () => {
    const broker = read("aws/broker.ts");
    expect(broker).toContain("if (ownCompany !== undefined && (definition.e2e !== undefined || setupApproval !== undefined)) throw agentXError(\"FORBIDDEN\", NAMED_COMPANY_SETUP_APPROVAL_REFUSED);");
    expect(broker).toMatch(/NAMED_COMPANY_SETUP_APPROVAL_REFUSED = "[^"]*Browser testing page/u);
    // The legacy account rows are still written under the legacy company only by that route; the new path never names it.
    for (const path of browserFiles) expect(read(path), path).not.toMatch(/LEGACY_E2E_COMPANY|IMPLICIT_COMPANY_ID/u);
  });
});

describe("approval authority is one rule, in two places", () => {
  it("the route and the decision's subject each ask for a live company owner or admin; neither falls back to the setup run's maintainer rule", () => {
    const routes = read("core-host/browser-testing-routes.ts");
    expect(routes).toMatch(/company-owner[\s\S]{0,80}company-admin/u);
    expect(routes).not.toMatch(/project-admin"\s*\)\s*;?\s*$/mu);
    expect(routes).not.toMatch(/isManage\b/u);
    const apply = read("core/setup-agent/apply.ts");
    expect(apply).toMatch(/async function requireBrowserApprovers[\s\S]{0,700}steps\.mayDecide\(/u);
    // ...and the decision calls it before anything else is decided or written.
    expect(apply).toMatch(/await requireBrowserApprovers\(approval, row, approvers\);\n\s+if \(approval === undefined\)/u);
    expect(read("core/setup-agent/browser-testing-approval.ts")).toMatch(/companyRole === "owner" \|\| standing\?\.companyRole === "admin"/u);
  });
});
