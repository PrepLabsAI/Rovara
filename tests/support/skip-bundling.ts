import { CONTEXT_ENV } from "aws-cdk-lib/cx-api";
import { afterAll } from "vitest";

/** CDK stops bundling the stacks this lists; empty means none, so NodejsFunction never runs esbuild. */
export const BUNDLING_STACKS_KEY = "aws:cdk:bundling-stacks";

/** What CDK_CONTEXT_JSON becomes with bundling off: the keys already in it, plus the empty list. */
export function contextJsonWithoutBundling(existing: string | undefined): string {
  let context: unknown = {};
  if (existing !== undefined && existing !== "") {
    try {
      context = JSON.parse(existing);
    } catch (error) {
      throw new Error(`${CONTEXT_ENV} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (typeof context !== "object" || context === null || Array.isArray(context)) {
      throw new Error(`${CONTEXT_ENV} is not a JSON object`);
    }
  }
  return JSON.stringify({ ...(context as Record<string, unknown>), [BUNDLING_STACKS_KEY]: [] });
}

/**
 * For a test file that only checks a template's shape: every CDK App it builds, however it builds
 * it (buildAgentXApp, or `new App()` beside a stack), skips bundling its Lambdas with esbuild. A
 * bundle takes most of a synth, and the template differs only in the asset hashes, which
 * normalizedTemplate (tests/support/template-snapshot.ts) already replaces.
 *
 * Call it at the top of the file, before anything builds an App: those run while the file loads.
 * Do not call it from a test that reads the bundle: the release builder's, the session
 * lifecycle's, or one that looks at the cloud assembly's asset directories.
 */
export function skipLambdaBundling(
  env: NodeJS.ProcessEnv = process.env,
  afterFile: (restore: () => void) => void = afterAll,
): void {
  const had = Object.hasOwn(env, CONTEXT_ENV);
  const before = env[CONTEXT_ENV];
  env[CONTEXT_ENV] = contextJsonWithoutBundling(before);
  afterFile(() => {
    if (had) env[CONTEXT_ENV] = before;
    else delete env[CONTEXT_ENV];
  });
}
