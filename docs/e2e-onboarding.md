# E2E setup: connect, inspect, decide

AgentX proposes project E2E setup from a source snapshot. The proposal is a starting point for an owner decision; it does not establish that a live workflow or external service is ready.

## Connect a project

Run `agentx --env <name> project add` from the project checkout and select a GitHub repository the AgentX GitHub App can access. Connect issue trackers separately with `agentx --env <name> connector add <linear|jira|asana> --project <project>`.

## Inspect the proposal

Before saving E2E setup, AgentX shows the proposed setup and readiness commands, detected targets, mock-substitutable inputs, and unresolved blockers. Review the source-backed targets and every proposed command. A mock substitution is allowed only for inputs the proposal marks `mock-substitutable`; unresolved inputs marked `blocking` remain blockers.

## Supported stacks

`project add` lists a browser or API target for every web or service `package.json` it finds (React Native packages get a mobile target and Electron packages a desktop target instead). A target is only runnable when Rovara can also build and start the app, which it can do for a Node.js app that:

- has a `package.json` with a `start` script (and optionally a `build` script) at the root of the repository, and an npm lockfile next to it (`package-lock.json` or `npm-shrinkwrap.json`). Rovara runs `npm ci`, then `npm run build` if there is one, then `npm start`.
- runs on Node 22 (the fixed image is `node:22.23.2-bookworm-slim`, arm64) and needs no outside service: no database, no docker-compose services, and no private package registry (an `.npmrc` is ignored and traffic to private networks is blocked).
- needs no secrets: environment variable names that contain TOKEN, SECRET, PASSWORD or API_KEY are refused.

A Node project with no start script, or with only a pnpm, yarn or bun lockfile, still gets a target in the proposal, but its browser and API checks stay unavailable until it has a start script and an npm lockfile.

`project add` says "no targets detected" when it finds no usable `package.json` (missing, unreadable, or past the limit on how many it reads) in the repository, as with a Python, Ruby, Go, Java or docker-compose project. Those projects are not supported yet.

## Approve or decline

Choose whether to use the proposed setup. AgentX records that choice against the immutable proposal reference and digest. Approving stores the proposal's E2E policy with the project revision. Declining records the decision and omits that E2E policy, so browser and API checks are off; the project keeps its own setup and test commands (the proposed ones and any you passed as flags), and you can run `agentx project setup-approve` later to turn the checks on.

A mock can support a local check of an isolated behavior. Approving that substitution keeps it in the saved proposal; it does not produce a runtime PASS or prove the corresponding live source, browser workflow, or customer path. Required evidence that remains missing or `UNKNOWN` must remain visible and cannot be treated as a pass.

If optional E2E discovery is unavailable or malformed, project onboarding can still complete; AgentX marks E2E discovery unavailable and keeps setup unresolved for a later retry. It does not turn partial discovery into an approved setup or runtime pass. A registered runtime catalog row is also not enough by itself: admission checks its scope, expiry, environment, installed manifest, and current worker readiness before execution.

Standard setup and feature runtime catalogs require a separate administrator-issued challenge and Linux ARM64 host qualification. Deployment provisions the pinned worker image and runtime prerequisites, but it does not run that qualification or register the catalogs. See [standard runtime qualification](runtime-installation.md) for the complete administrator/host/administrator procedure and its current limits.

## Evidence status

The [native P0 acceptance record](p0-native-journey-acceptance.md) summarizes the local synthetic journey, candidate-bound checks, evidence limits, and reproducible acceptance launcher. Its prior passing candidate does not qualify a later integrated commit; acceptance must be rerun against the exact candidate under review.

## Runtime expiry

The browser and API runtime registration is good for at most seven days, and not after the executor or worker image changes; an operator renews it with `npx tsx scripts/test-qualify-runtime.ts --env <env> --profile <aws-profile> --apply`. `agentx doctor` (with an admin sign-in) and `scripts/test-deploy.ts --check` warn when it expires within 48 hours, naming the expiry time and that command. A round refused because the registration expired says `runtime-expired`, and an administrator qualifies the runtime again, then retries the checks.
