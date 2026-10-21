import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INFERRED_APP_FILES, INFERRED_FIXTURE_ROOT } from "./e2e-inferred-fixture.js";

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

export type InferredAppProcess = Readonly<{ upstream: string; directory: string; stop(): Promise<void> }>;

/**
 * The inferred-recipe fixture app as the Rovara host would run it, but on this machine: its files in a scratch directory and `node server.mjs` on a loopback port given in PORT
 * (the recipe's `npm start` runs exactly that script). For executor tests that run the real CLI and a real local Chromium without Docker.
 */
export async function startInferredApp(): Promise<InferredAppProcess> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "inferred-app-")));
  const app = join(directory, "app");
  await mkdir(app, { recursive: true });
  for (const file of INFERRED_APP_FILES) await cp(join(INFERRED_FIXTURE_ROOT, file), join(app, file), { recursive: true });
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["server.mjs"], { cwd: app, env: { PATH: process.env.PATH ?? "", PORT: String(port) }, stdio: "ignore" });
  const upstream = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${upstream}/`)).status === 200) break; } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { upstream, directory, async stop() {
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  } };
}
