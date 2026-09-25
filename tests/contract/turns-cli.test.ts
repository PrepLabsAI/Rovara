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
  it.each([["30m", "2026-09-24T11:30:00.000Z"], ["12h", "2026-09-24T00:00:00.000Z"], ["7d", "2026-09-17T12:00:00.000Z"], ["30d", "2026-08-25T12:00:00.000Z"]])(
    "reads %s", (value, expected) => expect(parseSince(value, now)).toBe(expected));

  it.each(["31d", "0h", "7 days", "1w", ""])("refuses %j", (value) => {
    expect(() => parseSince(value, now)).toThrow(/CONFIG_INVALID: --since must/);
  });
});

describe("turn export client", () => {
  it("follows cursors and writes one JSON line per turn", async () => {
    const pages = [
      { turns: [{ eventId: "EvA00001" }, { eventId: "EvA00002" }], cursor: "c1" },
      { turns: [{ eventId: "EvA00003" }] },
    ];
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json(pages.shift()));
    const lines: string[] = [];
    const result = await exportTurns({ controlPlaneUrl: "https://agentx.example.test/", accessToken: "t", since: "2026-09-17T12:00:00.000Z", write: (line) => { lines.push(line); } }, fetchImplementation);
    expect(result).toEqual({ exported: 3, since: "2026-09-17T12:00:00.000Z" });
    expect(lines.map((line) => JSON.parse(line) as { eventId: string }).map((turn) => turn.eventId)).toEqual(["EvA00001", "EvA00002", "EvA00003"]);
    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
    const urls = fetchImplementation.mock.calls.map(([url]) => new URL(url as string));
    expect(urls.map((url) => [url.pathname, url.searchParams.get("since"), url.searchParams.get("cursor")])).toEqual([
      ["/v1/admin/turns", "2026-09-17T12:00:00.000Z", null], ["/v1/admin/turns", "2026-09-17T12:00:00.000Z", "c1"],
    ]);
    expect(new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer t");
  });

  it("stops on a repeated cursor instead of looping forever", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ turns: [], cursor: "same" }));
    await expect(exportTurns({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", since: "2026-09-17T12:00:00.000Z", write: () => undefined }, fetchImplementation))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("surfaces the server's refusal", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "FORBIDDEN", message: "administrator claim is required" } }, { status: 403 }));
    await expect(exportTurns({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", since: "2026-09-17T12:00:00.000Z", write: () => undefined }, fetchImplementation))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
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

  it("writes JSON Lines to stdout and the summary to stderr", async () => {
    const { tokens, globals } = await context();
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ turns: [{ eventId: "EvA00001" }] }));
    const { exitCode, stdout, stderr } = await run([...globals, "--json", "admin", "turns", "export", "--since", "7d"], tokens, fetchImplementation);
    expect(exitCode).toBe(0);
    expect(stdout).toBe(`${JSON.stringify({ eventId: "EvA00001" })}\n`);
    expect(JSON.parse(stderr)).toMatchObject({ ok: true, data: { exported: 1 } });
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

  it("refuses a bad duration before calling the control plane", async () => {
    const { tokens, globals } = await context();
    const fetchImplementation = vi.fn<typeof fetch>();
    const { exitCode } = await run([...globals, "admin", "turns", "export", "--since", "90d"], tokens, fetchImplementation);
    expect(exitCode).toBe(2);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
