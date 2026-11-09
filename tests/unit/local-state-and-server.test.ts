// Port lane L4: the state folder (owner-only files, where a config may live) and the 127.0.0.1-only HTTP server.
import { request } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalHttpServer, type LocalHttpServer } from "../../packages/broker/src/local/http-server.js";
import {
  LocalStateError,
  ensureStateDirectory,
  readConfigText,
  readOwnerFile,
  resolveConfigLocation,
  writeOwnerFile,
} from "../../packages/broker/src/local/state-directory.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});
async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rovara-l4-state-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

describe("local state folder", () => {
  it("makes the folder 0700 and refuses a link or a folder others can write to", async () => {
    const root = await folder();
    const state = await ensureStateDirectory(join(root, "state"));
    expect((await lstat(state)).mode & 0o777).toBe(0o700);
    await symlink(state, join(root, "link"));
    await expect(ensureStateDirectory(join(root, "link"))).rejects.toThrow(LocalStateError);
    await chmod(state, 0o777);
    await expect(ensureStateDirectory(state)).rejects.toThrow(/writable by other users/);
  });

  it("writes owner files 0600, and refuses to read one that others can read, a link, or a folder", async () => {
    const root = await folder();
    const path = join(root, "secret");
    await writeOwnerFile(path, "value\n");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await readOwnerFile(path, { private: true, label: "thing" }))?.text).toBe("value\n");
    await chmod(path, 0o644);
    await expect(readOwnerFile(path, { private: true, label: "thing" })).rejects.toThrow(/readable by other users/);
    await chmod(path, 0o600);
    await symlink(path, join(root, "link"));
    await expect(readOwnerFile(join(root, "link"), { private: true, label: "thing" })).rejects.toThrow(/plain file/);
    await mkdir(join(root, "dir"));
    await expect(readOwnerFile(join(root, "dir"), { private: true, label: "thing" })).rejects.toThrow();
    expect(await readOwnerFile(join(root, "absent"), { private: true, label: "thing" })).toBeUndefined();
  });

  it("does not replace a file made in the meantime when it writes exclusively, and leaves no temporary file", async () => {
    const root = await folder();
    const path = join(root, "config.json");
    await writeOwnerFile(path, "first", { exclusive: true });
    await writeOwnerFile(path, "second", { exclusive: true });
    expect((await readOwnerFile(path, { private: false, label: "config" }))?.text).toBe("first");
    await writeOwnerFile(path, "third");
    expect((await readOwnerFile(path, { private: false, label: "config" }))?.text).toBe("third");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(root)).toEqual(["config.json"]);
  });

  it("never quotes a file's content in an error", async () => {
    const root = await folder();
    const path = join(root, "big");
    await writeFile(path, "sk-ant-SECRET".repeat(100), { mode: 0o600 });
    const error = await readOwnerFile(path, { private: true, label: "thing", maxBytes: 10 }).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain("SECRET");
  });

  it("makes the first-run config in the state folder (0600), but never invents a config at a path the owner named", async () => {
    const state = await ensureStateDirectory(join(await folder(), "state"));
    const location = resolveConfigLocation({ stateDirectory: state, cwd: "/somewhere/else" });
    expect(location).toEqual({ path: join(state, "config.json"), isDefault: true });
    expect(JSON.parse(await readConfigText(location))).toEqual({ version: 1, plugins: [] });
    expect((await lstat(location.path)).mode & 0o777).toBe(0o600);
    await expect(readConfigText({ path: join(state, "named.json"), isDefault: false })).rejects.toThrow(/does not exist/);
  });

  it("refuses a config inside the folder the owner is standing in (a repository), and accepts one in the state folder or elsewhere", async () => {
    const root = await folder();
    const state = join(root, "home", ".rovara");
    const project = join(root, "project");
    expect(() => resolveConfigLocation({ stateDirectory: state, configPath: "./rovara.json", cwd: project })).toThrow(/inside the folder you are in/);
    expect(() => resolveConfigLocation({ stateDirectory: state, configPath: join(project, "sub", "config.json"), cwd: project })).toThrow(/repository/);
    expect(resolveConfigLocation({ stateDirectory: state, configPath: join(state, "mine.json"), cwd: state }).path).toBe(join(state, "mine.json"));
    expect(resolveConfigLocation({ stateDirectory: state, configPath: join(root, "elsewhere.json"), cwd: project }).isDefault).toBe(false);
  });

  it("refuses a config that others can write to", async () => {
    const state = await ensureStateDirectory(join(await folder(), "state"));
    const location = resolveConfigLocation({ stateDirectory: state, cwd: "/x" });
    await readConfigText(location);
    await chmod(location.path, 0o666);
    await expect(readConfigText(location)).rejects.toThrow(/writable by other users/);
  });
});

function get(url: string, options: { headers?: Record<string, string>; method?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({ host: target.hostname, port: target.port, path: target.pathname, method: options.method ?? "GET", headers: options.headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += String(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("local HTTP server", () => {
  async function start(): Promise<LocalHttpServer> {
    const server = await startLocalHttpServer({ handler: async (req) => ({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ path: req.path, size: req.body?.length ?? 0 }) }) });
    cleanup.push(() => server.close());
    return server;
  }

  it("binds to 127.0.0.1 on a random port and nothing else", async () => {
    const server = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.port).toBeGreaterThan(0);
    expect((await get(`${server.url}/anything`)).status).toBe(200);
    // It must not answer on the machine's other addresses.
    const { networkInterfaces } = await import("node:os");
    const outside = Object.values(networkInterfaces()).flat().find((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4");
    if (outside !== undefined) await expect(get(`http://${outside.address}:${server.port}/`)).rejects.toThrow();
  });

  it("refuses a Host header that is not its own name (DNS rebinding) and a request from another origin", async () => {
    const server = await start();
    expect((await get(`${server.url}/x`, { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await get(`${server.url}/x`, { headers: { host: `localhost:${server.port}` } })).status).toBe(200);
    expect((await get(`${server.url}/x`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await get(`${server.url}/x`, { headers: { origin: server.url } })).status).toBe(200);
  });

  it("refuses other methods and bodies over 1 MiB", async () => {
    const server = await start();
    expect((await get(`${server.url}/x`, { method: "DELETE" })).status).toBe(405);
    expect((await get(`${server.url}/x`, { method: "POST", body: "a".repeat(1_048_577) }).catch(() => ({ status: 413 }))).status).toBe(413);
    expect((await get(`${server.url}/x`, { method: "POST", body: "{}" })).status).toBe(200);
  });

  it("answers 500 without detail when the handler throws", async () => {
    const server = await startLocalHttpServer({ handler: async () => { throw new Error("secret detail"); } });
    cleanup.push(() => server.close());
    const answer = await get(`${server.url}/x`);
    expect(answer.status).toBe(500);
    expect(answer.body).not.toContain("secret");
  });
});
