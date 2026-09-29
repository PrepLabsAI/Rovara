// The `agentx doctor` command (FR-050, FR-051): prints every check, then exits non-zero when any
// failed. --json prints the whole report to stdout as {"ok": <no check failed>, "data": <report>};
// on a failure, stderr also gets agentx's usual {"ok": false, "error": ...} document and the exit
// code is 2.
import { agentXError } from "@agentx/contracts";
import type { Command } from "commander";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { EnvironmentSettings } from "../environments/settings.js";
import type { TextWriter } from "../init/prompts.js";
import { realDoctorServices } from "./aws.js";
import { reportText, type DoctorServices } from "./checks.js";
import { runDoctor } from "./run.js";

export interface DoctorCommandContext {
  store?: ParameterStore;
  services?: (settings: EnvironmentSettings) => DoctorServices;
  parameterStore: (region?: string) => ParameterStore;
  fetch: typeof fetch;
  home: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

export function registerDoctorCommand(program: Command, context: DoctorCommandContext): void {
  program
    .command("doctor")
    .description("check every piece of an environment and say what is wrong and how to fix it; exits non-zero when a check fails (operator role)")
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .action(async (options: { region?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ env: string; json: boolean; configDir: string }>();
      const store = context.store ?? context.parameterStore(options.region);
      const report = await runDoctor({
        env: globals.env, store,
        services: context.services ?? ((settings) => realDoctorServices({ settings, store, fetch: context.fetch, home: context.home, configDir: globals.configDir, stderr: context.stderr })),
      });
      // With --json, stdout holds one document whose ok is false when any check failed; the error
      // document on stderr (and exit code 2) says the same, as every agentx error does.
      context.stdout.write(globals.json ? `${JSON.stringify({ ok: report.failed === 0, data: report })}\n` : reportText(report));
      if (report.failed > 0) {
        throw agentXError("CONFIG_INVALID", `${report.failed} doctor ${report.failed === 1 ? "check" : "checks"} failed; fix what each one names, then run agentx doctor again`);
      }
    });
}
