import { describe, expect, it } from "vitest";
import { datasetRevision, loadSwebenchInstance } from "../../packages/worker/src/swebench/dataset.js";

/** A SEC-bench row; the hidden fields hold markers that must never reach the agent. */
const SECBENCH_ROW = {
  instance_id: "njs.cve-2022-32414",
  repo: "nginx/njs",
  project_name: "njs",
  lang: "c++",
  work_dir: "/src/njs",
  sanitizer: "address",
  bug_description: "A crash in njs_vmcode_interpreter when running a crafted script.",
  base_commit: "f65981b0b8fcf02d69a40bc934803c25c9f607ab",
  build_sh: "#!/bin/bash\n",
  secb_sh: "#!/bin/bash\n",
  dockerfile: "FROM base\n",
  patch: "MARKER-GOLD-PATCH",
  exit_code: 987654,
  sanitizer_report: "==1==ERROR: AddressSanitizer: SEGV on unknown address",
  bug_report: "MARKER-BUG-REPORT",
};

function fakeServer(rows: Array<Record<string, unknown>>, requested: string[] = []): typeof fetch {
  return (async (url: string) => {
    requested.push(url);
    return new Response(JSON.stringify({ rows: rows.map((row) => ({ row })), num_rows_total: rows.length }));
  }) as unknown as typeof fetch;
}

describe("loading a SEC-bench instance (spec 045 FR-003)", () => {
  it("reads the eval split and names the :patch image", async () => {
    const requested: string[] = [];
    const instance = await loadSwebenchInstance("secbench-patch", "njs.cve-2022-32414", { fetch: fakeServer([SECBENCH_ROW], requested) });
    expect(requested[0]).toContain("dataset=SEC-bench%2FSEC-bench");
    expect(requested[0]).toContain("split=eval");
    expect(instance).toMatchObject({ image: "hwiwonlee/secb.eval.x86_64.njs.cve-2022-32414:patch", work_dir: "/src/njs", problem_statement: SECBENCH_ROW.bug_description });
  });

  it.each(["/etc", "/src/../etc", "src/njs", "/src/", "/src/njs/./x"])("refuses the work_dir %j", async (work_dir) => {
    await expect(loadSwebenchInstance("secbench-patch", "njs.cve-2022-32414", { fetch: fakeServer([{ ...SECBENCH_ROW, work_dir }]) })).rejects.toThrow(/work_dir/);
  });

  it("refuses a row without its sanitizer report", async () => {
    await expect(loadSwebenchInstance("secbench-patch", "njs.cve-2022-32414", { fetch: fakeServer([{ ...SECBENCH_ROW, sanitizer_report: "" }]) })).rejects.toThrow(/sanitizer_report/);
  });

  it("keeps reading SWE-bench's test split", async () => {
    const requested: string[] = [];
    await loadSwebenchInstance("verified", "django__django-11099", {
      fetch: fakeServer([{ instance_id: "django__django-11099", repo: "django/django", base_commit: "a".repeat(40), problem_statement: "p", image: "swebench/x" }], requested),
    });
    expect(requested[0]).toContain("split=test");
  });

  it("reads the dataset revision, or none when Hugging Face does not answer", async () => {
    const ok = (async () => new Response(JSON.stringify({ sha: "11422e774857272b8f5460c699dca7a64046308b" }))) as unknown as typeof fetch;
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await datasetRevision("SEC-bench/SEC-bench", { fetch: ok })).toBe("11422e774857272b8f5460c699dca7a64046308b");
    expect(await datasetRevision("SEC-bench/SEC-bench", { fetch: down })).toBeUndefined();
  });
});
