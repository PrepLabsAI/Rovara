import { describe, expect, it } from "vitest";
import { MAX_LOADED_KNOWLEDGE_BYTES, MAX_LOADED_KNOWLEDGE_ITEMS, loadedKnowledgeOfProgress } from "@agentx/contracts";
import { EventBatcher, WORKER_EVENT_PAYLOAD_MAX_BYTES, type WorkerEvent } from "../../packages/worker/src/events.js";
import { buildLoadedKnowledgeManifest, loadedKnowledgePayload } from "../../packages/worker/src/knowledge/manifest.js";
import type { KnowledgeRecord, ResolvedKnowledge } from "../../packages/worker/src/knowledge/resolve.js";

const resolved = (records: KnowledgeRecord[]): ResolvedKnowledge => ({
  items: [], autoCatalog: [], autoItems: new Map(), manualItems: new Map(), pendingMatches: [], records, notices: [], diagnostics: [], skills: [], skippedSkills: [],
  budget: { alwaysOnBytes: 1, alwaysOnLimitBytes: 2, additionsBytes: 0, additionsLimitBytes: 2, skipped: 0 },
});
const record = (index: number, status: KnowledgeRecord["status"]): KnowledgeRecord => ({
  layer: "repo", repo: "r", path: `f${index}.md`, scopeDir: "", format: "agents_md", bytes: 1, status, ...(status === "skipped" ? { reason: "not_matched" as const } : {}),
});

describe("buildLoadedKnowledgeManifest", () => {
  it("lists everything, loaded items first, when it fits", () => {
    const records = [
      ...Array.from({ length: 60 }, (_unused, index) => record(index, "skipped")),
      ...Array.from({ length: 20 }, (_unused, index) => record(1000 + index, "loaded")),
      ...Array.from({ length: 30 }, (_unused, index) => record(2000 + index, "available")),
    ];
    const manifest = buildLoadedKnowledgeManifest({ stage: "plan", resolved: resolved(records), repositories: [{ name: "r", readAt: "working" }] });
    expect(manifest.items).toHaveLength(110);
    expect(MAX_LOADED_KNOWLEDGE_ITEMS).toBeGreaterThan(110);
    expect(manifest.items.slice(0, 20).every((item) => item.status === "loaded")).toBe(true);
    expect(manifest.omitted).toEqual({ skipped: 0, available: 0 });
  });

  it("removes hidden characters from names and paths, and carries the record under one event field", () => {
    const manifest = buildLoadedKnowledgeManifest({
      stage: "build", resolved: resolved([{ ...record(1, "loaded"), path: "a‮b.md", name: "n​m" }]), repositories: [],
    });
    expect(manifest.items[0]).toMatchObject({ path: "ab.md", name: "nm" });
    expect(Object.keys(loadedKnowledgePayload(manifest))).toEqual(["loadedKnowledge"]);
  });
});

const D = "a".repeat(64);
const fat = (index: number, status: KnowledgeRecord["status"] = "loaded"): KnowledgeRecord => ({
  layer: "repo", repo: "engine", path: `.cursor/rules/${"deep/".repeat(20)}rule-${String(index).padStart(3, "0")}.mdc`, scopeDir: "", format: "cursor_mdc", activation: "fileMatch",
  patterns: Array.from({ length: 20 }, (_unused, n) => `src/${"x".repeat(200)}/${String(n)}/**`), name: "n".repeat(200), bytes: 100, digest: D, fileDigest: D, readAt: "base", status,
  ...(status === "loaded" ? { why: { kind: "matched" as const, detail: "d".repeat(190) } } : status === "skipped" ? { reason: "not_matched" as const } : {}),
});

describe("the record fits the worker event", () => {
  it("is cut by bytes, keeps loaded items first, says it was cut, and still arrives through the event batcher", async () => {
    const records = [...Array.from({ length: 150 }, (_unused, index) => fat(index, "skipped")), ...Array.from({ length: 150 }, (_unused, index) => fat(1000 + index, "loaded"))];
    const manifest = buildLoadedKnowledgeManifest({ stage: "build", resolved: resolved(records), repositories: [{ name: "engine", readAt: "working" }] });
    expect(Buffer.byteLength(JSON.stringify(manifest), "utf8")).toBeLessThanOrEqual(MAX_LOADED_KNOWLEDGE_BYTES);
    expect(manifest.recordTruncated).toBe(true);
    expect(manifest.items.length + manifest.omitted.skipped + manifest.omitted.available + (manifest.omitted.loaded ?? 0)).toBe(300);
    expect(manifest.items[0]!.status).toBe("loaded");
    // Sent as the worker sends it: through the batcher, which drops a payload over 64 KiB whole.
    const sent: WorkerEvent[] = [];
    const batcher = new EventBatcher(async (events) => { sent.push(...events); }, 25, { maxDelayMs: false });
    await batcher.append("progress", loadedKnowledgePayload(manifest), { urgent: true });
    await batcher.flush();
    expect(Buffer.byteLength(JSON.stringify(sent[0]!.payload), "utf8")).toBeLessThanOrEqual(WORKER_EVENT_PAYLOAD_MAX_BYTES);
    expect(loadedKnowledgeOfProgress(sent[0]!.payload)).toEqual(manifest);
  });

  it("does not mark a record that fits", () => {
    const manifest = buildLoadedKnowledgeManifest({ stage: "plan", resolved: resolved([record(1, "loaded")]), repositories: [] });
    expect(manifest.recordTruncated).toBeUndefined();
  });

  it("a name or path that is only hidden characters drops that entry or field, not the record", () => {
    const manifest = buildLoadedKnowledgeManifest({
      stage: "plan", resolved: resolved([{ ...record(1, "loaded"), name: "\u200B\u202E" }, { ...record(2, "loaded"), path: "\u200B" }, record(3, "loaded")]), repositories: [],
    });
    expect(manifest.items.map((item) => item.path)).toEqual(["f1.md", "f3.md"]);
    expect(manifest.items[0]!.name).toBeUndefined();
  });

  it("carries the reviewer's role", () => {
    expect(buildLoadedKnowledgeManifest({ stage: "review", role: "SECURITY", resolved: resolved([]), repositories: [] }).role).toBe("SECURITY");
  });
});
