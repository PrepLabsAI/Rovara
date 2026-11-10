// Port lane P2, item C5 (decision 61): a repository's gates are generic external checks {provider, name, reference}; CodeBuild's gates are the same list in CodeBuild's words. The worker's job line is unchanged.
import { describe, expect, it } from "vitest";
import {
  CODEBUILD_CHECK_PROVIDER, CodeBuildGateDefinitionSchema, ExternalCheckSchema, ProjectDefinitionSchema, RepositoryDefinitionSchema, codeBuildGatesOf, externalCheckOfGate, gateOfExternalCheck,
  repositoryExternalChecks, workerProjectDefinition,
} from "@agentx/contracts";
import { CODEBUILD_RUNNER_KIND } from "../../packages/broker/src/plugins/check-runner/codebuild/index.js";

const repository = (extra: Record<string, unknown> = {}) => ({ name: "app", url: "https://github.com/acme/app", path: "app", defaultBranch: "main", credentialRef: "git", ...extra });
const gate = { name: "quality", projectName: "agentx-demo-quality", timeoutMinutes: 30 };
const check = { provider: "codebuild", name: "quality", reference: "agentx-demo-quality", timeoutMinutes: 30 };

describe("external checks", () => {
  it("names CodeBuild by the same word its check runner is registered under", () => {
    expect(CODEBUILD_CHECK_PROVIDER).toBe(CODEBUILD_RUNNER_KIND);
  });

  it("maps a CodeBuild gate to the generic check and back", () => {
    expect(externalCheckOfGate(gate)).toEqual(check);
    expect(gateOfExternalCheck(check)).toEqual(gate);
    expect(CodeBuildGateDefinitionSchema.parse(gateOfExternalCheck(externalCheckOfGate(gate)))).toEqual(gate);
    // CodeBuild's own rule survives the trip: its project must begin with agentx-.
    expect(() => gateOfExternalCheck({ ...check, reference: "other-project" })).toThrow();
    // A check of a provider no runner of this release runs is never turned into a gate: it must not be skipped.
    expect(() => gateOfExternalCheck({ provider: "examplebuild", name: "q", reference: "pipeline-1", timeoutMinutes: 10 })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("is one list: generic checks and gates are read together, once each", () => {
    const record = RepositoryDefinitionSchema.parse(repository({ codeBuildGates: [gate], externalChecks: [{ ...check, name: "lint", reference: "agentx-demo-lint" }] }));
    expect(repositoryExternalChecks(record).map((entry) => entry.name)).toEqual(["lint", "quality"]);
    expect(codeBuildGatesOf(record).map((entry) => entry.name)).toEqual(["quality", "lint"]);
    expect(repositoryExternalChecks(RepositoryDefinitionSchema.parse(repository()))).toEqual([]);
  });

  it("holds the old rules across both lists: unique names, unique CodeBuild projects, at most eight, at most 420 minutes, the agentx- prefix", () => {
    const refused = (extra: Record<string, unknown>) => !RepositoryDefinitionSchema.safeParse(repository(extra)).success;
    expect(refused({ codeBuildGates: [gate], externalChecks: [{ ...check, reference: "agentx-other" }] })).toBe(true);
    expect(refused({ codeBuildGates: [gate], externalChecks: [{ ...check, name: "other" }] })).toBe(true);
    expect(refused({ externalChecks: [{ ...check, reference: "not-agentx" }] })).toBe(true);
    expect(refused({ externalChecks: [{ ...check, timeoutMinutes: 4 }] })).toBe(true);
    expect(refused({ codeBuildGates: [{ ...gate, timeoutMinutes: 300 }], externalChecks: [{ ...check, name: "b", reference: "agentx-b", timeoutMinutes: 300 }] })).toBe(true);
    const many = (count: number, offset: number) => Array.from({ length: count }, (_, index) => ({ ...check, name: `c${String(index + offset)}`, reference: `agentx-p${String(index + offset)}`, timeoutMinutes: 5 }));
    expect(refused({ externalChecks: many(8, 0) })).toBe(false);
    expect(refused({ externalChecks: many(9, 0) })).toBe(true);
    expect(refused({ codeBuildGates: many(4, 0).map(({ name, reference, timeoutMinutes }) => ({ name, projectName: reference, timeoutMinutes })), externalChecks: many(5, 4) })).toBe(true);
    // Another provider's reference is its own business: no CodeBuild prefix rule applies to it.
    expect(refused({ externalChecks: [{ provider: "examplebuild", name: "q", reference: "pipeline/1", timeoutMinutes: 10 }] })).toBe(false);
    expect(ExternalCheckSchema.safeParse({ ...check, extra: 1 }).success).toBe(false);
  });

  it("sends a worker only the CodeBuild gates of its job line, never the generic field, and refuses to dispatch a check nobody runs", () => {
    const project = { name: "demo", repositories: [RepositoryDefinitionSchema.parse(repository({ codeBuildGates: [gate], externalChecks: [{ ...check, name: "lint", reference: "agentx-demo-lint" }] }))] };
    const sent = workerProjectDefinition(project) as { repositories: Array<Record<string, unknown>> };
    expect(sent.repositories[0]).not.toHaveProperty("externalChecks");
    expect((sent.repositories[0]!["codeBuildGates"] as Array<{ name: string }>).map((entry) => entry.name)).toEqual(["quality", "lint"]);
    const unrun = { name: "demo", repositories: [RepositoryDefinitionSchema.parse(repository({ externalChecks: [{ provider: "examplebuild", name: "q", reference: "pipeline/1", timeoutMinutes: 10 }] }))] };
    expect(() => workerProjectDefinition(unrun)).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
    // A repository with neither is unchanged.
    expect(workerProjectDefinition({ name: "d", repositories: [RepositoryDefinitionSchema.parse(repository())] })).toEqual({ name: "d", repositories: [RepositoryDefinitionSchema.parse(repository())] });
    expect(ProjectDefinitionSchema).toBeDefined();
  });
});
