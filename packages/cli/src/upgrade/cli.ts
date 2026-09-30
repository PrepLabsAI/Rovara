// The `agentx upgrade` command (FR-042 to FR-044, FR-026's upgrade --export), kept out of main.ts.
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { STSClient } from "@aws-sdk/client-sts";
import type { Command } from "commander";
import { cdkDiff } from "../deploy/cdk-engine.js";
import { prepareDeployment, readlineAsk, realCommandRunner, type DeployCliDependencies } from "../deploy/commands.js";
import { loadRelease } from "../deploy/release.js";
import { realDoctorServices } from "../doctor/aws.js";
import { runDoctor } from "../doctor/run.js";
import { cloudFormationStackReader, stsCallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { TextWriter } from "../init/prompts.js";
import { fetchRelease, sourceRelease } from "../init/release-fetch.js";
import { formatSuccess } from "../output.js";
import { RELEASE_VERSION } from "../version.js";
import { runUpgrade, type UpgradeDependencies } from "./run.js";
import { releaseNotes } from "./target.js";

export interface UpgradeCommandContext {
  overrides?: Partial<UpgradeDependencies>;
  deploy?: DeployCliDependencies;
  parameterStore: (region?: string) => ParameterStore;
  fetch: typeof fetch;
  home: string;
  stdout: TextWriter;
  stderr: TextWriter;
}

const collect = (value: string, previous: string[]) => [...previous, value];

export function registerUpgradeCommand(program: Command, context: UpgradeCommandContext): void {
  program
    .command("upgrade")
    .description("upgrade an environment to a newer release: shows the release notes and every change, stops on a data replacement unless you name it, then runs doctor (operator role; the cdk engine needs admin credentials)")
    .option("--to <version>", "the release to upgrade to; default: this agentx's own release, or for an agentx built from source upgrading a cdk environment, the --source tag")
    .option("--release <dir>", "a release directory (agentx release build output) instead of downloading one")
    .option("--source <dir>", "the cdk engine only: a clean checkout of the target release's tag; --to or --release, when given, must match it")
    .option("--allow-replace <logical-id>", "accept replacing or deleting this table, user pool, bucket, key or secret; repeat for each", collect, [])
    .option("--export <dir>", "write the upgrade for a platform team's pipeline instead of deploying it")
    .option("--worker-image <digest-ref>", "worker image by digest; an agentx built from source needs it with --engine cdk when the tag has no published release.json")
    .option("--slack-image <digest-ref>", "Slack service image by digest; an agentx built from source needs it with --engine cdk when the tag has no published release.json")
    .option("--yes", "apply without asking; every change and the release notes are still printed", false)
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .action(async (options: { to?: string; release?: string; source?: string; allowReplace: string[]; export?: string; workerImage?: string; slackImage?: string; yes: boolean; region?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ env: string; json: boolean; configDir: string }>();
      const overrides = context.overrides ?? {};
      const aws = options.region === undefined ? {} : { region: options.region };
      const store = overrides.store ?? context.parameterStore(options.region);
      const runner = realCommandRunner(context.stderr);
      const write = overrides.write ?? ((line: string) => { context.stderr.write(`${line}\n`); });
      const deps: UpgradeDependencies = {
        store,
        stacks: overrides.stacks ?? cloudFormationStackReader(new CloudFormationClient(aws)),
        cloudFormation: overrides.cloudFormation ?? new CloudFormationClient(aws),
        identity: overrides.identity ?? stsCallerIdentity(new STSClient(aws)),
        loadRelease: overrides.loadRelease ?? (async (input) => loadRelease(input.releaseDir ?? await fetchRelease({ version: input.version, home: context.home, fetch: context.fetch, runner, write }))),
        sourceRelease: overrides.sourceRelease ?? (async (input) => (await sourceRelease({ runner, source: input.source, images: input.images, fetch: context.fetch })).release),
        notes: overrides.notes ?? ((version) => releaseNotes({ fetch: context.fetch, version })),
        prepare: overrides.prepare ?? ((input) => prepareDeployment({
          engine: input.settings.engine, env: input.settings.env, region: input.settings.region, account: input.settings.account,
          identityMode: input.settings.identity.mode, release: input.release, ...(input.source === undefined ? {} : { source: input.source }),
          deps: context.deploy ?? {}, stderr: context.stderr,
        })),
        cdkDiff: overrides.cdkDiff ?? ((request, settings, source) => cdkDiff({ runner, source, env: settings.env, region: settings.region, identityMode: settings.identity.mode, request })),
        ask: overrides.ask ?? readlineAsk(),
        isInteractive: overrides.isInteractive ?? (() => process.stdin.isTTY === true),
        doctor: overrides.doctor ?? ((env) => runDoctor({ env, store, services: (settings) => realDoctorServices({ settings, store, fetch: context.fetch, home: context.home, configDir: globals.configDir, stderr: context.stderr }) })),
        write,
        now: overrides.now ?? Date.now,
        cliVersion: "cliVersion" in overrides ? overrides.cliVersion : RELEASE_VERSION,
      };
      const images = options.workerImage === undefined && options.slackImage === undefined ? undefined : {
        ...(options.workerImage === undefined ? {} : { worker: options.workerImage }), ...(options.slackImage === undefined ? {} : { slack: options.slackImage }),
      };
      const result = await runUpgrade({
        env: globals.env, yes: options.yes, allowReplace: options.allowReplace,
        ...(options.to === undefined ? {} : { to: options.to }), ...(options.release === undefined ? {} : { releaseDir: options.release }),
        ...(options.source === undefined ? {} : { source: options.source }), ...(options.export === undefined ? {} : { exportDir: options.export }),
        ...(images === undefined ? {} : { images }),
      }, deps);
      context.stdout.write(globals.json ? formatSuccess(result, true) : result.exported !== undefined
        ? `Wrote the upgrade of ${result.env} to ${result.to} to ${result.exported}; give it to your platform team.\n`
        : `Upgraded ${result.env} from ${result.from} to ${result.to}.\n`);
    });
}
