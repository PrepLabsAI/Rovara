// What automation may never reach, held by reading the code itself (the same way the ports' own tests hold their imports):
//   1. it decides nothing for a person: no automation file imports a decision, a merge or a second-review module, and the only place a proof is checked is `authority.ts`, through the `Approvers` port;
//   2. it names no provider: no AWS client, no document-client call, no Cloud-only folder;
//   3. the one door: nothing but `run-seam.ts` and the host's starter calls `starter.start`.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../packages/broker/src/core");
const FOLDERS = ["automation", "automatic-runs", "triggers", "chains", "agents"];

function files(folder: string): string[] {
  return readdirSync(join(ROOT, folder), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(folder, entry.name)) : entry.name.endsWith(".ts") ? [join(folder, entry.name)] : []));
}
const all = FOLDERS.flatMap(files);
const source = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const importsOf = (text: string): string[] => [...text.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]!);


describe("automation's boundaries", () => {
  it("has files to read", () => {
    expect(all.length).toBeGreaterThanOrEqual(20);
  });

  it("imports nothing that decides for a person", () => {
    const banned = /\/(decisions|merge|second-review|design-review|sessions|e2e|build-step)\//u;
    const offenders = all.flatMap((file) => importsOf(source(file)).filter((specifier) => banned.test(specifier)).map((specifier) => `${file}: ${specifier}`));
    expect(offenders).toEqual([]);
  });

  it("checks a proof in one place", () => {
    const verifying = all.filter((file) => /\.verify\(/u.test(source(file)));
    expect(verifying).toEqual([join("automation", "authority.ts")]);
    // And nothing builds a proof: no automation file makes an `ApprovalProof`.
    expect(all.filter((file) => /proofId\s*:/u.test(source(file)))).toEqual([]);
  });

  it("names no provider and no Cloud-only folder", () => {
    const banned = /@aws-sdk|documentClient|\/(org|spend|audit|team-record|devices)\//u;
    const offenders = all.flatMap((file) => importsOf(source(file)).filter((specifier) => banned.test(specifier)).map((specifier) => `${file}: ${specifier}`));
    expect(offenders).toEqual([]);
    expect(all.filter((file) => /documentClient|TableName|ConditionExpression/u.test(source(file)))).toEqual([]);
  });

  it("starts unattended work through one door", () => {
    const callers = all.filter((file) => /\.starter\.start\(|starter\.start\(/u.test(source(file)));
    expect(callers.map((file) => relative(ROOT, join(ROOT, file)))).toEqual([join("automation", "run-seam.ts")]);
  });
});
