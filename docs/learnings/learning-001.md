# Learning 001: tests see `@agentx/contracts` through its build, so a red run needs a rebuild

- **Date:** 2026-10-04
- **Source:** system-feedback
- **Work item:** issue-299

## What happened

`@agentx/contracts` exports `./dist/index.js`, and vitest has no alias to its source. To record red→green, the new tests
were run against the old `packages/contracts/src/checks.ts`, and they passed. The tests were reading the `dist` built
from the new code. Worker code under `packages/worker/src` is imported from source, so only contracts changes behave
this way.

## Learning

A test run sees a change to `packages/contracts/src` only after `npx tsc -b packages/contracts` (or `npm run build`).
That holds for the green run, and for a red run made by checking out older source.

## Action

When proving red→green for a contracts change: check out the old source, rebuild contracts, run the tests, restore,
rebuild, run again. Never trust a red or green result taken without the rebuild.
