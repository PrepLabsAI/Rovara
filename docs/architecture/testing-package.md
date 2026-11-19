# @agentx/testing

What a provider package runs against its adapter before it is trusted. Step 0 of the modularization plan: a new adapter (a code host, a tracker, a check runner, a chat tool) is
accepted when the same suites that the in-repo fakes and the shipped adapters pass also pass on it, and when the isolation kit shows it keeps companies apart.

## What is in it

| Entry | What it holds |
| --- | --- |
| `@agentx/testing` | everything below, re-exported |
| `@agentx/testing/ports/<name>` | one conformance suite per port: a list of named checks over a "world" (`runContract` registers one test per check) |
| `@agentx/testing/fakes` | the fakes the suites run on (code host, tracker, check runner, channel and the memory ports) |
| `@agentx/testing/channel` | the channel suite, a world for the fake adapter, and a world for the real Slack adapter over a fake network |
| `@agentx/testing/isolation` | the two-company isolation kit and the worlds that apply it |

## Running a suite on a new adapter

Build a world for the adapter (the adapter, a driver that puts the host's state in place, and the raw ids it uses), then:

```ts
import { runContract } from "@agentx/testing/ports/plugin-contract-kit";
import { codeHostChecks } from "@agentx/testing/ports/code-host-conformance";
runContract("MyHost passes the CodeHost contract", codeHostChecks, () => myHostWorld());
```

A check the adapter cannot run (a capability it does not advertise, a promise it does not make) shows as skipped with its name, never as passed. `options.skip` lists known gaps by
check name with the reason, so a gap is visible.

## The channel suite

`channelChecks` covers what a chat adapter owns: every event is shown in the conversation it names (text, a card with the exact request on each button, private notes, no repeats,
the tool's markup kept out, long text cut, a failed send retried once, no credential in an error or a log), and what it hears is neutral (a mention as a message, a press as a decision
for exactly the card's request, a request for changes with the person's own words, nothing unaddressed, nothing after stop).
`slackChannelWorld()` is the proof on a real adapter: the shipped `SlackChannel` over a fake `fetch` and a driven socket. Only the chat tool's network is fake.

## The isolation kit

`@agentx/testing/isolation` proves that data, events, secrets and approvals of company A never reach company B through a port implementation that serves both.

- An `IsolationSurface` is one thing a company can put in and get out of an adapter. `plant(me)` puts a marked thing in through the port under raw ids both companies share;
  `observe(as)` does what that company can do and returns what it saw. The kit plants for both, observes as each, and fails when an observation holds the other company's marker or
  none of its own (so a surface that looks at nothing cannot pass).
- A `FailClosedProbe` runs an operation while the adapter's company lookup throws, and again while it answers nothing. It must be refused or answer nothing, and no company's marker
  may come out.
- `twoCompanyChecks()` is appended to a suite's checks. A world with an `isolation` member runs them; a world without one shows them as skipped.
- `routeByCompany` builds a many-company adapter from one adapter per company (the fake of a hosted adapter). It fails closed with one fixed sentence.
- `createCompanySecretStore` is a secret store that keeps a ledger and fails a read made for another company while a call is made for this one; `assertNoSecretLeaks` and
  `captureLogs` grep errors, logs and results for planted secrets.
- `fakeCodeHostCompanies`, `fakeTrackerCompanies` and `fakeCheckRunnerCompanies` apply the kit to the fakes. `slackChannelCompanies` and `fakeChannelCompanies` apply it to the chat
  adapter through the core's own channel code (the sink, the cards, the links and the bindings): events, per-company tokens, and approvals decided only by the company that owns the card.

Each set is proved able to fail: `tests/unit/testing-isolation-kit.test.ts` and `tests/unit/testing-channel-isolation.test.ts` build routers, token readers and lookups that leak in
one specific way and show the check that guards it catches them.

## Rules for fixtures

The repository is public: never put a real-looking key or token in a fixture. Build fake tokens at run time from parts (`slackTokens()`); the fakes' webhook secrets are public
constants and must never be registered in a production build.
