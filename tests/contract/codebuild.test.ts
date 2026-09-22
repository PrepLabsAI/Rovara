import { BatchGetBuildsCommand, StartBuildCommand } from "@aws-sdk/client-codebuild";
import { describe, expect, it, vi } from "vitest";
import { AwsCodeBuildGateway } from "../../packages/broker/src/codebuild.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { runCodeBuildGates } from "../../packages/worker/src/codebuild.js";
import type { WorkerInvocation } from "@agentx/contracts";

describe("CodeBuild broker adapter", () => {
  it("starts an approved project at the exact commit without mutable build overrides", async () => {
    const commit = "a".repeat(40);
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(StartBuildCommand);
      const input = (command as StartBuildCommand).input;
      expect(input).toEqual({
        projectName: "agentx-website-quality",
        sourceVersion: commit,
        timeoutInMinutesOverride: 30,
        idempotencyToken: "b".repeat(64),
      });
      return {
        build: {
          id: `agentx-website-quality:${crypto.randomUUID()}`,
          projectName: "agentx-website-quality",
          buildStatus: "IN_PROGRESS",
          sourceVersion: commit,
          startTime: new Date("2026-09-19T12:00:00.000Z"),
        },
      };
    });
    const gateway = new AwsCodeBuildGateway({ send });
    const result = await gateway.start({
      gate: "quality",
      projectName: "agentx-website-quality",
      commit,
      timeoutMinutes: 30,
      idempotencyToken: "b".repeat(64),
    });
    expect(result).toMatchObject({ gate: "quality", status: "IN_PROGRESS", requestedSourceVersion: commit });
  });

  it("normalizes terminal evidence and rejects missing or mismatched builds", async () => {
    const commit = "c".repeat(40);
    const buildId = `agentx-website-quality:${crypto.randomUUID()}`;
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(BatchGetBuildsCommand);
      return {
        builds: [{
          id: buildId,
          projectName: "agentx-website-quality",
          buildStatus: "SUCCEEDED",
          resolvedSourceVersion: commit,
          currentPhase: "COMPLETED",
          startTime: new Date("2026-09-19T12:00:00.000Z"),
          endTime: new Date("2026-09-19T12:02:00.000Z"),
          logs: { deepLink: "https://console.aws.amazon.com/codesuite/codebuild/builds/example" },
        }],
      };
    });
    const gateway = new AwsCodeBuildGateway({ send });
    await expect(gateway.status({
      gate: "quality",
      projectName: "agentx-website-quality",
      commit,
      buildId,
    })).resolves.toMatchObject({ status: "SUCCEEDED", resolvedSourceVersion: commit, currentPhase: "COMPLETED" });

    const missing = new AwsCodeBuildGateway({
      send: vi.fn(async () => ({ builds: [], buildsNotFound: [buildId] })),
    });
    await expect(missing.status({
      gate: "quality", projectName: "agentx-website-quality", commit, buildId,
    })).rejects.toThrow(/not found/i);
  });
});

describe("CodeBuild worker gate runner", () => {
  const gate = { name: "quality", projectName: "agentx-website-quality", timeoutMinutes: 5 } as const;

  it("polls to success, verifies the resolved commit, and returns evidence", async () => {
    const commit = "d".repeat(40);
    const buildId = `${gate.projectName}:${crypto.randomUUID()}`;
    const sink = vi.fn(async (request: { action: "start" | "status" }) => ({
      gate: gate.name,
      projectName: gate.projectName,
      buildId,
      status: request.action === "start" ? "IN_PROGRESS" as const : "SUCCEEDED" as const,
      requestedSourceVersion: commit,
      ...(request.action === "status" ? { resolvedSourceVersion: commit } : {}),
    }));
    const result = await runCodeBuildGates({
      repository: "website",
      commit,
      gates: [gate],
      sink,
      wait: async () => undefined,
    });
    expect(result).toHaveLength(1);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("fails on terminal failure, source mismatch, and a bounded polling deadline", async () => {
    const commit = "e".repeat(40);
    const base = {
      gate: gate.name,
      projectName: gate.projectName,
      buildId: `${gate.projectName}:${crypto.randomUUID()}`,
      requestedSourceVersion: commit,
    };
    await expect(runCodeBuildGates({
      repository: "website", commit, gates: [gate],
      sink: async () => ({ ...base, status: "FAILED" }),
    })).rejects.toThrow(/FAILED/);
    await expect(runCodeBuildGates({
      repository: "website", commit, gates: [gate],
      sink: async () => ({ ...base, status: "SUCCEEDED", resolvedSourceVersion: "f".repeat(40) }),
    })).rejects.toThrow(/different source revision/i);
    let clock = 0;
    await expect(runCodeBuildGates({
      repository: "website", commit, gates: [gate],
      sink: async () => ({ ...base, status: "IN_PROGRESS" }),
      now: () => clock,
      wait: async () => { clock = 500_000; },
      queueAllowanceMilliseconds: 0,
    })).rejects.toThrow(/deadline/i);
  });

  it("accepts broker request metadata without weakening the strict build schema", async () => {
    const operationId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const commit = "1".repeat(40);
    const invocation = {
      operationId,
      workspaceId,
      callbackCapability: "c".repeat(64),
    } as WorkerInvocation;
    const callbacks = createWorkerCallbackSinks({
      controlPlaneUrl: "https://agentx.example.test",
      invocation,
      fetchImplementation: vi.fn(async () => Response.json({
        gate: "quality",
        projectName: "agentx-website-quality",
        buildId: `agentx-website-quality:${crypto.randomUUID()}`,
        status: "SUCCEEDED",
        requestedSourceVersion: commit,
        resolvedSourceVersion: commit,
        requestId: "gateway-request",
      })),
    });
    await expect(callbacks.codeBuildSink({
      action: "start",
      repository: "website",
      gate: "quality",
      projectName: "agentx-website-quality",
      commit,
    })).resolves.toMatchObject({ status: "SUCCEEDED", resolvedSourceVersion: commit });
  });
});
