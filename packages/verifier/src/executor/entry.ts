import { runE2EExecutor } from "./run.js";

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
  const result = await runE2EExecutor({ planPath, outDir, signal: controller.signal });
  process.exitCode = result.exitCode;
} catch (error) {
  crash(error);
}
