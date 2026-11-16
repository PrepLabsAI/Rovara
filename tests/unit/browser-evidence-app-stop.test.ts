// TE-H1: stopping the project's app waits for the WHOLE process group, not only the shell that started it. A shell dies on SIGTERM at once while the app it started can hold the port a moment longer; the next
// side (the candidate's app on the same port) must find the port free, or it is refused as "the app did not start" (found on the first Linux CI run, where the shell is dash).
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startProjectApp } from "../../packages/verifier/src/executor/browser-evidence-chromium.js";

const listening = (port: number) => new Promise<boolean>((resolve) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});
const freePort = () => new Promise<number>((resolve) => {
  const server = connect({ host: "127.0.0.1", port: 1 });
  server.once("error", () => { resolve(20_000 + Math.floor(Math.random() * 20_000)); });
});

describe("stopping the project's app", () => {
  // The app is a grandchild that takes 400 ms to leave after SIGTERM, while its shell leaves at once.
  const app = (port: number) => `(${JSON.stringify(process.execPath)} -e 'const s=require("http").createServer((q,r)=>r.end("ok")).listen(${String(port)},"127.0.0.1");process.on("SIGTERM",()=>setTimeout(()=>{s.close();process.exit(0)},400))') & wait`;

  it("returns only when nothing of the app is left: the port is free the moment stop() answers", async () => {
    const port = await freePort();
    const started = await startProjectApp({ command: app(port), cwd: process.cwd(), port, readyPath: "/", timeoutMs: 20_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    if (started.status !== "ready") throw new Error(`the app did not start: ${started.status}`);
    expect(await listening(port)).toBe(true);
    await started.app.stop();
    expect(await listening(port)).toBe(false);
    // A second app on the same port starts at once (the candidate's side after the base code's).
    const again = await startProjectApp({ command: app(port), cwd: process.cwd(), port, readyPath: "/", timeoutMs: 20_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    expect(again.status).toBe("ready");
    if (again.status === "ready") await again.app.stop();
  }, 60_000);
});
