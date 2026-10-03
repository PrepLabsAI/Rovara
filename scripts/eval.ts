// npm run eval -- [--live [--model <id>] [--provider <id>] [--update-baseline]] [--repeat <n>] [--presentation new|legacy] [--cases <dir>]
// npm run eval -- --sc004 [--model <id>] compares the two committed baselines for SC-004 and calls no model.
// Without --live it runs offline on Pi's faux provider and calls no model. --live calls the
// configured model through Pi with ambient credentials (AWS credentials with Bedrock access for the
// default, amazon-bedrock / us.anthropic.claude-sonnet-4-6). A live run never runs in CI.
// Run `npm run build` first: tests/eval/case.ts imports the broker's connector types, which import
// @agentx/gateway from its dist build.
import { runEvalCli } from "../tests/eval/command.js";

try {
  const outcome = await runEvalCli(process.argv.slice(2));
  for (const line of outcome.lines) process.stdout.write(`${line}\n`);
  process.exitCode = outcome.exitCode;
} catch (error) {
  process.stderr.write(`eval: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
