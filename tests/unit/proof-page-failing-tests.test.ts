// TE-A6 (DEC 254zzf): the task page (Code's proof page) lists the failing tests of a failed check with the change that most likely broke each, or "unknown", as inert text, ten tests across the page. A pack without
// causes gives the report and page it always did.
import { describe, expect, it } from "vitest";
import { EVIDENCE_RENDER_LIMITS, type EvidencePack } from "../../packages/contracts/src/index.js";
import { renderProof, type PageContext } from "../../packages/broker/src/core/local-pages/pages.js";
import { failuresOf, proofReportOf } from "../../packages/broker/src/local/app/proof-report.js";
import { v1Pack } from "../support/evidence-v2-fixtures.js";

const SHA = "a".repeat(40);
const change = (path: string, commit?: string) => ({ kind: "change" as const, paths: [path], pathsCount: 1, ...(commit === undefined ? {} : { commit }), basis: ["named_in_failure" as const] });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ids = (count: number, prefix = "t") => Array.from({ length: count }, (_, index) => `tests/${prefix}.test.ts::case ${String(index)}`);
/** A v1 pack whose first check failed with these failing tests and (optionally) these causes; `second` adds a second failed check. */
function packWith(failing: string[], causes?: unknown, second?: { failing: string[]; causes?: unknown }): EvidencePack {
  const pack = clone(v1Pack()) as unknown as { checks: Array<Record<string, unknown>> };
  const failedCheck = (base: Record<string, unknown>, names: string[], withCauses: unknown, checkId: string) => ({
    ...base, checkId, after: "failed", class: "regression", exitCode: 1,
    tests: { total: names.length + 1, passed: 1, failed: names.length, skipped: 0, errored: 0, names: [...names.map((name) => ({ name, status: "failed" })), { name: "tests/ok.test.ts::fine", status: "passed" }], newTests: [], ...(withCauses === undefined ? {} : { failureCauses: withCauses }) },
  });
  pack.checks[0] = failedCheck(pack.checks[0]!, failing, causes, "readiness:0");
  if (second !== undefined) pack.checks.push(failedCheck({ ...pack.checks[0], label: "second suite" }, second.failing, second.causes, "readiness:9"));
  return pack as unknown as EvidencePack;
}
const report = (pack: EvidencePack | undefined) => proofReportOf({ taskId: "t", title: "T", workspaceId: "w" } as never, { revision: 1 } as never, pack);
const context: PageContext = { base: "/s/x", nonce: "n", sessionId: "s", formToken: () => "ft" };
const FAILING = ["tests/cart.test.ts::applies discount", "tests/cart.test.ts::rounds"];
const GOOD = [{ testId: FAILING[0]!, cause: change("src/cart.ts", SHA) }, { testId: FAILING[1]!, cause: { kind: "unknown" as const, reason: "weak_evidence" as const } }];

describe("the failing tests on the task page", () => {
  it("lists each failing test of a failed check with its likely cause or unknown", () => {
    expect(report(packWith(FAILING, GOOD)).failures).toEqual({
      checks: [{ check: "pytest -q", tests: [
        { test: FAILING[0], cause: "likely broken by a change (commit aaaaaaa) to src/cart.ts" },
        { test: FAILING[1], cause: "unknown (only weak evidence)" },
      ] }],
      more: 0,
    });
    const html = renderProof(context, report(packWith(FAILING, GOOD)));
    expect(html).toContain('id="failing-tests"');
    expect(html).toContain("<code>tests/cart.test.ts::applies discount</code>: likely broken by a change (commit aaaaaaa) to src/cart.ts");
    expect(html).toContain("unknown (only weak evidence)");
  });

  it("golden: without causes (or a pack, or a check that did not fail) the report has no failures key and the page has no such section", () => {
    for (const pack of [packWith(FAILING), undefined, v1Pack()]) {
      const made = report(pack);
      expect(Object.keys(made)).not.toContain("failures");
      expect(renderProof(context, made)).not.toContain("failing-tests");
    }
    const passed = clone(packWith(FAILING, GOOD)) as unknown as { checks: Array<{ after: string }> };
    passed.checks[0]!.after = "passed";
    expect(failuresOf(passed as unknown as EvidencePack)).toBeUndefined();
    // Byte for byte: the same pack with and without the causes gives the same report apart from the new field.
    const withCauses = { ...report(packWith(FAILING, GOOD)) } as Record<string, unknown>;
    delete withCauses["failures"];
    expect(JSON.stringify(withCauses)).toBe(JSON.stringify(report(packWith(FAILING))));
  });

  it("lists at most ten tests across all checks and counts the rest", () => {
    const first = ids(7, "a");
    const second = ids(6, "b");
    const make = (names: string[]) => names.map((testId) => ({ testId, cause: change("src/a.ts", SHA) }));
    const view = report(packWith(first, make(first), { failing: second, causes: make(second) })).failures!;
    expect(view.checks.map((check) => check.tests.length)).toEqual([7, EVIDENCE_RENDER_LIMITS.failureCausesListed - 7]);
    expect(view.more).toBe(3);
    const html = renderProof(context, report(packWith(first, make(first), { failing: second, causes: make(second) })));
    expect(html).toContain("and 3 more failing tests with a cause not listed");
    expect(html.match(/<li><code>/gu)).toHaveLength(EVIDENCE_RENDER_LIMITS.failureCausesListed);
  });

  it("adds nothing for causes it cannot read (a newer shape, wrong types, none)", () => {
    for (const odd of [[{ testId: "x", cause: { kind: "from_the_future" } }], "text", 5, [], [{ nope: 1 }]]) expect(failuresOf(packWith(FAILING, odd))).toBeUndefined();
  });

  it("shows only plain text: a hostile test id and path cannot make a link, tag, mention or secret", () => {
    const secret = `ghp_${"Ab1Cd2Ef3Gh4".repeat(3)}`;
    const hostile = `[x](https://evil.example/p) @owner #12 <img src=x onerror=alert(1)> ${secret}`;
    const id = `tests/${hostile}.test.ts::a`;
    const html = renderProof(context, report(packWith([id], [{ testId: id, cause: change(`src/${hostile}.ts`, SHA) }])));
    const section = html.slice(html.indexOf('id="failing-tests"'), html.indexOf("</section>", html.indexOf('id="failing-tests"')));
    expect(section).not.toContain("<img");
    expect(section).not.toContain(secret);
    expect(section).not.toMatch(/href=|https:\/\/evil/u);
    expect(section).toContain("likely broken by");
    expect(section).not.toContain("@owner");
    expect(section).not.toContain("#12");
  });

  it("a hostile check label is plain text too", () => {
    const pack = clone(packWith(FAILING, GOOD)) as unknown as { checks: Array<{ label: string }> };
    pack.checks[0]!.label = "[x](https://evil.example/p) <b>bold</b> @owner";
    const html = renderProof(context, report(pack as unknown as EvidencePack));
    const section = html.slice(html.indexOf('id="failing-tests"'));
    expect(section).not.toMatch(/<b>bold|https:\/\/evil|@owner/u);
  });

  it("a check with nothing left to list adds no empty heading, and a check that timed out or is unknown shows nothing", () => {
    const first = ids(10, "a");
    const second = ids(3, "b");
    const make = (names: string[]) => names.map((testId) => ({ testId, cause: change("src/a.ts", SHA) }));
    const view = report(packWith(first, make(first), { failing: second, causes: make(second) })).failures!;
    expect(view.checks).toHaveLength(1);
    expect(view.more).toBe(3);
    for (const after of ["timed_out", "unknown", "not_run"]) {
      const pack = clone(packWith(FAILING, GOOD)) as unknown as { checks: Array<{ after: string }> };
      pack.checks[0]!.after = after;
      expect(failuresOf(pack as unknown as EvidencePack)).toBeUndefined();
    }
  });

  it("the page escapes whatever a view holds, even text that was not made plain upstream", () => {
    const view = { ...report(undefined), failures: { checks: [{ check: "<b>suite</b>", tests: [{ test: "<img src=x onerror=alert(1)>", cause: "<script>alert(1)</script>" }] }], more: 1 } };
    const html = renderProof(context, view);
    expect(html).not.toMatch(/<img src=x|<script>alert|<b>suite/u);
    expect(html).toContain("&lt;img");
    expect(html).toContain("and 1 more failing test with a cause not listed");
  });

  it("two checks, two sections: each failed check keeps its own tests under its own name", () => {
    const view = report(packWith(FAILING, GOOD, { failing: ["tests/other.test.ts::x"], causes: [{ testId: "tests/other.test.ts::x", cause: { kind: "unknown", reason: "no_failure_details" } }] })).failures!;
    expect(view.checks.map((check) => [check.check, check.tests.map((test) => test.test)])).toEqual([["pytest -q", FAILING], ["second suite", ["tests/other.test.ts::x"]]]);
  });
});
