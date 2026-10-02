// packages/cli/src/init/cli-command.ts
// Issue #222 and spec 048 FR-059 and FR-061: a command shown on the page works as shown. The
// published package is named only when this CLI runs from it; a CLI built from source is shown by
// its own path.
// Owner decision 2026-10-02 (#218, #235 follow-up): a live message about the command running right
// now goes further, when it knows how npm launched this very process: the installed package's bin
// shows as the bare `agentx` command, not as the universally-working `npx` suggestion that a
// persisted (not live) hint still falls back to when it was never told.
import { realpathSync } from "node:fs";
import { RELEASE_VERSION } from "../version.js";

export interface CliInvocation { published: boolean; version?: string; cliPath: string; invokedViaNpx?: boolean }

const resolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** True when npm launched this process as `npx ...`: npm 7+ implements npx as `npm exec`, so it sets `npm_command=exec`; a bare, directly-invoked installed command sets no npm_* env vars at all. */
function ranViaNpx(env: NodeJS.ProcessEnv): boolean {
  return env.npm_command === "exec";
}

export function currentCliInvocation(
  argv1: string = process.argv[1] ?? "agentx",
  version: string | undefined = RELEASE_VERSION,
  env: NodeJS.ProcessEnv = process.env,
): CliInvocation {
  const cliPath = resolved(argv1);
  const published = version !== undefined && /[\\/]node_modules[\\/]@charterarc[\\/]agentx[\\/]/.test(cliPath);
  return { published, ...(version === undefined ? {} : { version }), cliPath, invokedViaNpx: ranViaNpx(env) };
}

const quoted = (path: string): string => (/^[A-Za-z0-9_./:@-]+$/.test(path) ? path : `"${path.replaceAll('"', '\\"')}"`);

/**
 * The command a person can run, in the form that works for them: the published package by its
 * version through `npx` when `invokedViaNpx` is not explicitly false (the ready screen's own,
 * universally-working suggestion for a command that may run on a different computer later); the
 * bare installed command when this very process just told us npm did not launch it as npx; the
 * CLI's own path otherwise (not published, or published with no known version: a build from
 * source).
 */
export function cliCommandLine(invocation: CliInvocation, args: string): string {
  if (!invocation.published || invocation.version === undefined) return `node ${quoted(invocation.cliPath)} ${args}`;
  if (invocation.invokedViaNpx === false) return `agentx ${args}`;
  return `npx @charterarc/agentx@${invocation.version} ${args}`;
}
