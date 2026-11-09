// Port lane L2: what the code-host, tracker and check-runner plug-in points hold. The interfaces themselves (`CodeHost`, `Tracker`,
// `CheckRunner`) are Cloud's, in `../plugins/`; they use neutral words only (change request, revision, check, item), and an adapter
// is chosen by name, never by branching on a provider. This file adds what the registry needs on top of them.
import type { CheckRunner } from "../plugins/check-runner.js";
import type { PluginKind } from "../plugins/common.js";

/** What a check runner is built for: the repositories the caller's project registered (a runner that builds for an address it was not told about refuses). */
export interface CheckRunnerContext {
  readonly allowedRepositories: readonly string[];
}

/**
 * The `check-runner` point holds a factory, not a runner: a runner such as CodeBuild is built for the repositories of one project. The
 * registry name is `kind`. `create` is called for each project, so it must be cheap, synchronous and must not keep state between projects. `allowedRepositories` is
 * advisory for a runner that has no scope of its own (GitHub Actions leaves the repository check to its client's installation binding); CodeBuild enforces it.
 */
export interface CheckRunnerAdapter {
  readonly kind: PluginKind;
  create(context: CheckRunnerContext): CheckRunner;
}
