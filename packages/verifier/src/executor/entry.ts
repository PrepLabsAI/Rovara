// The AI SDK resolves a string model id through a global default provider; the executor has none and must not fall back to a gateway. This runs before anything else loads.
import { installRefusingE2EDefaultProvider } from "./ai-default-provider.js";
installRefusingE2EDefaultProvider();

// The host mounts the plan read-only and an empty writable out directory; both paths are fixed by the container contract
// and can be overridden by arguments (`entry.js <plan> <out>`) or ROVARA_EXECUTOR_PLAN / ROVARA_EXECUTOR_OUT.
const planPath = process.argv[2] ?? process.env.ROVARA_EXECUTOR_PLAN ?? "/run/rovara/plan.json";
const outDir = process.argv[3] ?? process.env.ROVARA_EXECUTOR_OUT ?? "/out";
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => controller.abort(new Error(`executor received ${signal}`)));

// Exit 1 means "completed with failures". A crash is never that: any uncaught error says no result exists (exit 2).
const crash = (error: unknown) => {
  process.stderr.write(`executor crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(2);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

try {
  if (process.argv[2] === "--mock") {
    // The second mode of this image: an approved origin's mock, or the sinkhole of every other declared origin. It serves until the host removes the container.
    const { runMockMode } = await import("./mock-server.js");
    const mock = await runMockMode(process.argv.slice(2));
    controller.signal.addEventListener("abort", () => { void mock.close().finally(() => process.exit(0)); }, { once: true });
  } else {
    const { runE2EExecutor } = await import("./run.js");
    const result = await runE2EExecutor({ planPath, outDir, signal: controller.signal });
    process.exitCode = result.exitCode;
  }
} catch (error) {
  crash(error);
}
