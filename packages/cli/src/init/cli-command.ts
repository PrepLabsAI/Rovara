// packages/cli/src/init/cli-command.ts
// Issue #222 and spec 048 FR-059 and FR-061: a command shown on the page works as shown. The
// published package is named only when this CLI runs from it; a CLI built from source is shown by
// its own path.
import { realpathSync } from "node:fs";
import { RELEASE_VERSION } from "../version.js";

export interface CliInvocation { published: boolean; version?: string; cliPath: string }

const resolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export function currentCliInvocation(argv1: string = process.argv[1] ?? "agentx", version: string | undefined = RELEASE_VERSION): CliInvocation {
  const cliPath = resolved(argv1);
  const published = version !== undefined && /[\\/]node_modules[\\/]@charterarc[\\/]agentx[\\/]/.test(cliPath);
  return { published, ...(version === undefined ? {} : { version }), cliPath };
}

const quoted = (path: string): string => (/^[A-Za-z0-9_./:@-]+$/.test(path) ? path : `"${path.replaceAll('"', '\\"')}"`);

export function cliCommandLine(invocation: CliInvocation, args: string): string {
  return invocation.published && invocation.version !== undefined
    ? `npx @charterarc/agentx@${invocation.version} ${args}`
    : `node ${quoted(invocation.cliPath)} ${args}`;
}
