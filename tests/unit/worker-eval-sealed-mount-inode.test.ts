// TE-F3: the hidden-round path guards also compare device and inode, which no spelling of a path can change (a bind mount, a name differing only in case). The file system is wrapped so two different paths answer with one inode.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as NodeFs from "node:fs";

const same = vi.hoisted(() => ({ pairs: [] as Array<[string, string]> }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>();
  return {
    ...original,
    statSync: ((path: NodeFs.PathLike, options?: unknown) => {
      const text = String(path);
      const real = (original.statSync as (p: NodeFs.PathLike, o?: unknown) => NodeFs.BigIntStats)(path, options);
      for (const [from, to] of same.pairs) if (text === from) return (original.statSync as (p: NodeFs.PathLike, o?: unknown) => NodeFs.BigIntStats)(to, options);
      return real;
    }) as typeof original.statSync,
  };
});

const { checkSandboxPlan } = await import("../../packages/worker/src/check-sandbox.js");
const { runNetworkAddresses, runNetworkLabelArgs, runNetworkName } = await import("../../packages/worker/src/run-network.js");
const { mkdtemp, mkdir, realpath, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");

const RUN = "11111111-1111-4111-8111-111111111111";
const a = runNetworkAddresses(5);
const net = { name: runNetworkName(RUN), slot: 5, subnet: a.subnet, dnsHelperIp: a.dnsHelperIp, workingSandboxIp: a.workingSandboxIp, checkSandboxIp: a.checkSandboxIp, labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: "0123456789abcdef", createdAt: 1, expiresAt: 2 }) };
const plan = (copy: string, task: string, hidden: string) => checkSandboxPlan({
  net, taskId: "t", image: "worker:img", guardImage: `sha256:${"c".repeat(64)}`, rootPath: copy, maskedPaths: [], filesDir: "/run/rovara/check-1", helpers: [], sinkholeIp: a.subnet.replace(/\.0\/24$/u, ".16"),
  hiddenEvalSetPath: hidden, hiddenRoundWorkspace: { copyPath: copy, taskWorkspacePath: task },
});

describe("device and inode, not only the spelling of a path", () => {
  /** Two separate trees: `a` holds the hidden set; `b` holds the task workspace and the copy. Only the inode answers are bent, one case at a time, so each guard is alone in what it catches. */
  async function trees(run: (p: { a: string; hidden: string; b: string; task: string; copy: string }) => void | Promise<void>) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "te-f3-inode-")));
    try {
      const p = { a: join(root, "a"), hidden: join(root, "a", "hidden"), b: join(root, "b"), task: join(root, "b", "task"), copy: join(root, "b", "copy") };
      for (const dir of [p.a, p.hidden, p.b, p.task, p.copy]) await mkdir(dir);
      same.pairs = [];
      await run(p);
    } finally { same.pairs = []; await rm(root, { recursive: true, force: true }); }
  }
  it("plans when nothing is bent", async () => {
    await trees(({ copy, task, hidden }) => { expect(() => plan(copy, task, hidden)).not.toThrow(); });
  });
  it("refuses a copy that has the task workspace's inode (a bind mount), under another name", async () => {
    await trees(({ copy, task, hidden }) => { same.pairs = [[copy, task]]; expect(() => plan(copy, task, hidden)).toThrow(/task workspace/u); });
  });
  it("refuses a copy that sits inside the task workspace by inode, and a task workspace that sits inside the copy by inode, each alone", async () => {
    await trees(({ b, copy, task, hidden }) => {
      same.pairs = [[b, task]]; // the copy's parent is the task workspace
      expect(() => plan(copy, task, hidden)).toThrow(/task workspace/u);
      same.pairs = [[b, copy]]; // the task workspace's parent is the copy
      expect(() => plan(copy, task, hidden)).toThrow(/task workspace/u);
    });
  });
  it("refuses a hidden set that sits INSIDE a workspace by inode (its parent is the task workspace, or the copy)", async () => {
    await trees(({ a, copy, task, hidden }) => {
      same.pairs = [[a, task]];
      expect(() => plan(copy, task, hidden)).toThrow(/inside a workspace/u);
      same.pairs = [[a, copy]];
      expect(() => plan(copy, task, hidden)).toThrow(/inside a workspace/u);
    });
  });
  it("refuses a hidden set that is AROUND a workspace by inode (it is the parent of the task workspace, or of the copy)", async () => {
    await trees(({ b, copy, task, hidden }) => {
      same.pairs = [[hidden, b]];
      expect(() => plan(copy, task, hidden)).toThrow(/inside a workspace/u);
    });
  });
  it("refuses a hidden set that IS a workspace by inode", async () => {
    await trees(({ copy, task, hidden }) => {
      same.pairs = [[hidden, task]];
      expect(() => plan(copy, task, hidden)).toThrow(/inside a workspace/u);
      same.pairs = [[hidden, copy]];
      expect(() => plan(copy, task, hidden)).toThrow(/inside a workspace/u);
    });
  });
});
