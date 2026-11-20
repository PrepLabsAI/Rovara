import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportTurns, parseSince } from "../../packages/cli/src/admin/turns.js";
import { tokenStoreKey } from "../../packages/cli/src/auth.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const now = Date.parse("2026-09-24T12:00:00.000Z");

describe("turn export duration", () => {

  it.each(["31d", "7 days"])("refuses %j", (value) => {
    expect(() => parseSince(value, now)).toThrow(/CONFIG_INVALID: --since must/);
  });
});

describe("turn export client", () => {

  it("stops on a repeated cursor instead of looping forever", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ turns: [], cursor: "same" }));
    await expect(exportTurns({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", since: "2026-09-17T12:00:00.000Z", write: () => undefined }, fetchImplementation))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

});

describe("agentx admin turns export", () => {
  const deployment = { controlPlaneUrl: "http://127.0.0.1:8787", auth: { issuer: "https://identity.example.test", clientId: "agentx-client", audience: "agentx-api" } };

  async function context() {
    const directory = await mkdtemp(join(tmpdir(), "agentx-cli-turns-"));
    const deploymentFile = join(directory, "deployment.yaml");
    await writeFile(deploymentFile, JSON.stringify(deployment), "utf8");
    const tokens = new InMemoryTokenStore();
    await tokens.set(tokenStoreKey(deployment.auth), { accessToken: "access-secret", expiresAt: Date.now() + 60_000 });
    return { directory, tokens, globals: ["--config-dir", directory, "--deployment-file", deploymentFile, "--allow-loopback"] };
  }

  async function run(args: string[], tokens: InMemoryTokenStore, fetchImplementation: typeof fetch) {
    let stdout = "";
    let stderr = "";
    const exitCode = await executeCli(args, {
      fetchImplementation, tokenStore: tokens,
      stdout: { write(text: string) { stdout += text; } },
      stderr: { write(text: string) { stderr += text; } },
    });
    return { exitCode, stdout, stderr };
  }

  it("prints the total skipped malformed records on stderr", async () => {
    const { tokens, globals } = await context();
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ turns: [{ eventId: "EvA00001" }], skipped: 2 }));
    const { exitCode, stdout, stderr } = await run([...globals, "--json", "admin", "turns", "export", "--since", "7d"], tokens, fetchImplementation);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`${JSON.stringify({ eventId: "EvA00001" })}\n`);
    expect(JSON.parse(stderr)).toMatchObject({ ok: true, data: { exported: 1, skipped: 2 } });
  });

  it("names the count when a stdout export fails partway, keeping the error code", async () => {
    const { tokens, globals } = await context();
    const pages = [{ turns: [{ eventId: "EvA00001" }, { eventId: "EvA00002" }], cursor: "c1" }];
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      if (pages.length > 0) return Response.json(pages.shift());
      return Response.json({ error: { code: "FORBIDDEN", message: "administrator claim is required" } }, { status: 403 });
    });
    const { exitCode, stdout, stderr } = await run([...globals, "--json", "admin", "turns", "export", "--since", "12h"], tokens, fetchImplementation);
    expect(exitCode).toBe(4);
    expect(stdout.trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(stderr)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "turn export failed after 2 records: FORBIDDEN: administrator claim is required" },
    });
  });

  it("writes to an owner-only file with --output", async () => {
    const { directory, tokens, globals } = await context();
    const output = join(directory, "turns.jsonl");
    await writeFile(output, "old", { mode: 0o644 });
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ turns: [{ eventId: "EvA00001" }, { eventId: "EvA00002" }] }));
    const { exitCode, stdout } = await run([...globals, "admin", "turns", "export", "--since", "12h", "--output", output], tokens, fetchImplementation);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect((await readFile(output, "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it("leaves no target or partial file when the export fails partway, and names the count", async () => {
    const { directory, tokens, globals } = await context();
    const output = join(directory, "turns.jsonl");
    const pages = [{ turns: [{ eventId: "EvA00001" }], cursor: "c1" }];
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      if (pages.length > 0) return Response.json(pages.shift());
      return Response.json({ error: { code: "FORBIDDEN", message: "administrator claim is required" } }, { status: 403 });
    });
    const { exitCode, stderr } = await run([...globals, "--json", "admin", "turns", "export", "--since", "12h", "--output", output], tokens, fetchImplementation);
    expect(exitCode).toBe(4);
    expect(JSON.parse(stderr)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "turn export failed after 1 records; no file was written: FORBIDDEN: administrator claim is required" },
    });
    await expect(stat(output)).rejects.toThrow();
    await expect(stat(`${output}.partial`)).rejects.toThrow();
  });

});
