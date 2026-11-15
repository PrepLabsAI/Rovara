// General fakes slice 1 (DEC 234): a CHECKS round with Rovara-made fakes beside it, on the local shell. A real project command calls the base-URL variable and gets the fake's answer; every check a fake
// answered is reported as made by Rovara (never proof); a failed check after a call the fake could not answer is "Not run" with a fixed reason; without a plan nothing changes.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GENERAL_FAKE_LABEL, GENERAL_FAKE_NOT_RUN_SENTENCES, type GeneralFakesPayload } from "@agentx/contracts";
import { CheckNotRunError, createCheckRunners, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { GENERAL_FAKES_DISCOVERY_LIMITS, generalFakesPlanFor, withGeneralFakesRound, type GeneralFakesRoundResult } from "../../packages/worker/src/general-fakes-round.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const PETS = JSON.stringify({
  openapi: "3.0.3", info: { title: "pets", version: "1" }, servers: [{ url: "https://pets.example.test/v1" }],
  paths: {
    "/pets/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1, maximum: 9 }, name: { type: "string" } } } } } } } } },
    "/odd": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "string", enum: ["a"] } } } } } } },
  },
});

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rovara-general-fakes-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function planOf(root: string, payload: GeneralFakesPayload, results: GeneralFakesRoundResult[], repositoryPaths = [join(root, "repo")]) {
  const plan = generalFakesPlanFor(payload, { localShell: true, rootPath: root, repositoryPaths, onResult: (result) => results.push(result) });
  if (plan === undefined) throw new Error("expected a plan");
  return plan;
}

// The test program a customer would have: it calls the service through its own base-URL variable.
const call = (path: string, expectStatus = 200) => [
  "-e",
  `fetch(process.env.PETS_API_URL + ${JSON.stringify(path)}).then(async (r) => { const t = await r.text(); console.log(r.status + " " + t); process.exit(r.status === ${String(expectStatus)} ? 0 : 1); }, () => process.exit(3));`,
];
const run = (runners: CheckRunners, args: string[], env?: Record<string, string>) => runners.runProjectCommand({ cwd: ".", executable: process.execPath, args, timeoutSeconds: 30, ...(env === undefined ? {} : { env }) }, new AbortController().signal);

describe("withGeneralFakesRound", () => {
  it("is the same runners object without a plan (byte-identical when the setting is off)", () => {
    const runners = createCheckRunners({ rootPath: tmpdir(), local: true });
    expect(withGeneralFakesRound(undefined, runners)).toBe(runners);
  });

  it("makes no plan without the payload, and none off the local shell", () => {
    const options = { localShell: true, rootPath: tmpdir(), repositoryPaths: [], onResult: () => undefined };
    expect(generalFakesPlanFor(undefined, options)).toBeUndefined();
    expect(generalFakesPlanFor({ services: [{ variable: "PETS_API_URL" }] }, { ...options, localShell: false })).toBeUndefined();
  });

  it("a real project command gets the fake's answer through its base-URL variable, and the check is reported as made by Rovara", async () => {
    const root = await workspace({ "repo/api/openapi.json": PETS });
    const results: GeneralFakesRoundResult[] = [];
    const runners = withGeneralFakesRound(planOf(root, { services: [{ variable: "PETS_API_URL" }] }, results), createCheckRunners({ rootPath: root, local: true }));
    runners.beginCheck?.("readiness:0");
    const result = await run(runners, call("/pets/4"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('200 {"id":5,"name":"example"}');
    // The server's base path is honoured too (a variable that holds only the host).
    runners.beginCheck?.("readiness:1");
    expect((await run(runners, call("/v1/pets/4"))).exitCode).toBe(0);
    await runners.endRound?.();
    expect(results).toHaveLength(1);
    expect(results[0]!.facts).toEqual({ unknown: false, checks: [{ checkId: "readiness:0", served: 1 }, { checkId: "readiness:1", served: 1 }] });
    expect(results[0]!.lines).toEqual([expect.stringMatching(new RegExp(`^${GENERAL_FAKE_LABEL}: 2 outside calls`, "u"))]);
  });

  it("the fake replaces the project's own value of the variable, and the base URL is a loopback address", async () => {
    const root = await workspace({ "repo/openapi.json": PETS });
    const runners = withGeneralFakesRound(planOf(root, { services: [{ variable: "PETS_API_URL" }] }, []), createCheckRunners({ rootPath: root, local: true }));
    runners.beginCheck?.("readiness:0");
    const result = await run(runners, ["-e", "console.log(process.env.PETS_API_URL)"], { PETS_API_URL: "https://real.example.test" });
    expect(result.stdout.trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/0$/u);
    await runners.endRound?.();
  });

  it("a failed check after a call the fake could not answer is Not run with the reason, never failed; a passing one stays passed and still counts as fake-answered", async () => {
    const root = await workspace({ "repo/openapi.json": PETS });
    const results: GeneralFakesRoundResult[] = [];
    const runners = withGeneralFakesRound(planOf(root, { services: [{ variable: "PETS_API_URL" }] }, results), createCheckRunners({ rootPath: root, local: true }));
    runners.beginCheck?.("readiness:0");
    await expect(run(runners, call("/owners"))).rejects.toEqual(new CheckNotRunError(GENERAL_FAKE_NOT_RUN_SENTENCES.operation_unknown));
    runners.beginCheck?.("readiness:1");
    await expect(run(runners, call("/odd"))).rejects.toEqual(new CheckNotRunError(GENERAL_FAKE_NOT_RUN_SENTENCES.operation_unsupported));
    runners.beginCheck?.("readiness:2");
    expect((await run(runners, call("/owners", 501))).exitCode).toBe(0);
    await runners.endRound?.();
    expect(results[0]!.facts.checks).toEqual([{ checkId: "readiness:0", served: 1 }, { checkId: "readiness:1", served: 1 }, { checkId: "readiness:2", served: 1 }]);
  });

  it("no description, two descriptions, an unreadable one and one outside the workspace each give their own Not run reason", async () => {
    const cases: [Record<string, string>, GeneralFakesPayload["services"][number], keyof typeof GENERAL_FAKE_NOT_RUN_SENTENCES][] = [
      [{ "repo/readme.md": "x" }, { variable: "PETS_API_URL" }, "no_spec"],
      [{ "repo/a/openapi.json": PETS, "repo/b/openapi.yaml": PETS }, { variable: "PETS_API_URL" }, "spec_ambiguous"],
      [{ "repo/openapi.yaml": "openapi: [unclosed" }, { variable: "PETS_API_URL", spec: "repo/openapi.yaml" }, "spec_unreadable"],
      [{ "repo/swagger.json": JSON.stringify({ swagger: "2.0", paths: {} }) }, { variable: "PETS_API_URL", spec: "repo/swagger.json" }, "spec_unreadable"],
      [{ "repo/x.txt": "x" }, { variable: "PETS_API_URL", spec: "repo/missing.yaml" }, "spec_unreadable"],
    ];
    for (const [files, service, reason] of cases) {
      const root = await workspace(files);
      const runners = withGeneralFakesRound(planOf(root, { services: [service] }, []), createCheckRunners({ rootPath: root, local: true }));
      runners.beginCheck?.("readiness:0");
      await expect(run(runners, call("/pets/1")), reason).rejects.toEqual(new CheckNotRunError(GENERAL_FAKE_NOT_RUN_SENTENCES[reason]));
      await runners.endRound?.();
    }
    const outside = await workspace({ "elsewhere/openapi.json": PETS });
    const root = await workspace({ "repo/x.txt": "x" });
    await symlink(join(outside, "elsewhere", "openapi.json"), join(root, "repo", "linked.json"));
    const runners = withGeneralFakesRound(planOf(root, { services: [{ variable: "PETS_API_URL", spec: "repo/linked.json" }] }, []), createCheckRunners({ rootPath: root, local: true }));
    runners.beginCheck?.("readiness:0");
    await expect(run(runners, call("/pets/1"))).rejects.toEqual(new CheckNotRunError(GENERAL_FAKE_NOT_RUN_SENTENCES.spec_unreadable));
    await runners.endRound?.();
  });

  it("discovery that hits its entry limit never picks a file: it asks for one to be named", async () => {
    const files: Record<string, string> = { "repo/openapi.json": PETS };
    for (let index = 0; index <= GENERAL_FAKES_DISCOVERY_LIMITS.entries; index += 1) files[`repo/many/f${String(index)}.txt`] = "";
    const root = await workspace(files);
    const runners = withGeneralFakesRound(planOf(root, { services: [{ variable: "PETS_API_URL" }] }, []), createCheckRunners({ rootPath: root, local: true }));
    runners.beginCheck?.("readiness:0");
    await expect(run(runners, call("/pets/1"))).rejects.toEqual(new CheckNotRunError(GENERAL_FAKE_NOT_RUN_SENTENCES.spec_ambiguous));
    await runners.endRound?.();
  });

  it("a call no check can be blamed for (during setup, or with an unreadable check id) makes the round's facts unknown", async () => {
    const root = await workspace({ "repo/openapi.json": PETS });
    const results: GeneralFakesRoundResult[] = [];
    const runners = withGeneralFakesRound(planOf(root, { services: [{ variable: "PETS_API_URL" }] }, results), createCheckRunners({ rootPath: root, local: true }));
    await runners.scopeSetup!(async () => { expect((await run(runners, call("/pets/1"))).exitCode).toBe(0); });
    runners.beginCheck?.("readiness:0");
    expect((await run(runners, ["-e", "1"])).exitCode).toBe(0);
    await runners.endRound?.();
    expect(results[0]!.facts).toEqual({ unknown: true, checks: [{ checkId: "readiness:0", served: 1 }] });

    const second: GeneralFakesRoundResult[] = [];
    const again = withGeneralFakesRound(planOf(root, { services: [{ variable: "PETS_API_URL" }] }, second), createCheckRunners({ rootPath: root, local: true }));
    again.beginCheck?.("not a check id");
    expect((await run(again, call("/pets/1"))).exitCode).toBe(0);
    await again.endRound?.();
    expect(second[0]!.facts.unknown).toBe(true);
  });

  it("reasons and lines carry no path, variable, host or body", async () => {
    const root = await workspace({ "repo/secret-dir/openapi.yaml": "openapi: [x" });
    const results: GeneralFakesRoundResult[] = [];
    const runners = withGeneralFakesRound(planOf(root, { services: [{ variable: "PETS_API_URL", spec: "repo/secret-dir/openapi.yaml" }] }, results), createCheckRunners({ rootPath: root, local: true }));
    runners.beginCheck?.("readiness:0");
    const error = await run(runners, call("/pets/zzz-private")).catch((caught: unknown) => caught);
    await runners.endRound?.();
    const text = `${String((error as Error).message)} ${JSON.stringify(results)}`;
    expect(text).toContain("Not run:");
    expect(text).not.toMatch(/secret-dir|PETS_API_URL|zzz-private|127\.0\.0\.1|openapi\.yaml/u);
  });

  it("the server is stopped when the round ends", async () => {
    const root = await workspace({ "repo/openapi.json": PETS });
    const runners = withGeneralFakesRound(planOf(root, { services: [{ variable: "PETS_API_URL" }] }, []), createCheckRunners({ rootPath: root, local: true }));
    runners.beginCheck?.("readiness:0");
    const url = (await run(runners, ["-e", "console.log(process.env.PETS_API_URL)"])).stdout.trim();
    await runners.endRound?.();
    await expect(fetch(`${url}/pets/1`)).rejects.toThrow();
  });
});
