// The worker image's SWE-bench mode (spec 043 FR-008): one run, then exit. The eval instance's boot
// script runs `node packages/worker/dist/swebench-main.js` with the run in AGENTX_SWEBENCH_RUN.
import { SwebenchRunnerConfigSchema } from "@agentx/contracts";
import { createDockerCli } from "./swebench/containers.js";
import { createRunReporter } from "./swebench/reporter.js";
import { runSwebench } from "./swebench/run.js";
import { resolveTaskModel } from "./task-model.js";

const log = (event: string, fields: Record<string, unknown> = {}) => {
  process.stdout.write(`${JSON.stringify({ component: "swebench-runner", event, ...fields })}\n`);
};

try {
  const config = SwebenchRunnerConfigSchema.parse(JSON.parse(process.env.AGENTX_SWEBENCH_RUN ?? "null"));
  log("run.starting", { runId: config.runId, dataset: config.dataset, instanceId: config.instanceId });
  const result = await runSwebench(config, {
    rootPath: process.env.AGENTX_SWEBENCH_ROOT ?? "/mnt/eval",
    model: resolveTaskModel(config.model),
    docker: createDockerCli(),
    reporter: createRunReporter(config),
    log,
  });
  log("run.finished", { outcome: result.outcome, ...(result.outcome === "GRADED" ? { resolved: result.resolved } : {}) });
} catch (error) {
  // Only an unreadable configuration or an unreachable control plane gets here; the instance's
  // time limit ends the run.
  log("run.unreported", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
