# Agents pick the models Rovara's AI serves

DEC 243c (Rovara's AI offers every Bedrock coding model, not only Claude), DEC 236j (model choices are made on the web page only, after a fresh step-up) and DEC 240 (the customer pays for Rovara's AI).

## What Code does

- A company chooses the model each step of its agents runs on (the same per-step rule the laptop has: understand, plan, build, the checks, the pull request step) on the web page, from the models the gateway offers THAT company.
  - `GET /v1/app/agent-models`: any member reads the setting and the whole offered list (`AgentModelPage`: `state` plus `offered`).
  - `POST /v1/app/agent-models`: the change (`ModelSelectionBody`). Only right after a fresh step-up the route checks itself (an API token or script token has none and is refused in fixed words), only by an owner or administrator (live role from membership), and only for a model on the offered list now. A less-safe change still needs the company's approval rule.
  - The choice is the company's own `MODEL_SELECTION_POLICY` row (company-keyed). Project-level choices are not built (the laptop rule has none either).
- The core engine runs every step on the model the rule chooses, always through the gateway's agent route (`/v1/messages`, Anthropic Messages) with the model's own name as the alias and as the catalog entry. A model that is not on the offered list is never CHOSEN for a step: the step ends before any machine starts, with fixed words. Two things keep what they hold, because the gateway checks the company's source and meters every call anyway: a step that already holds its choice (a repeat delivery after the model left the list), and an operation with no model step of its own (it runs on the default model). With nothing chosen a step runs on the install's default model (`ROVARA_CORE_AGENT_MODEL`), as before, and is refused the same way if that model is no longer offered.
- A list that cannot be read, or is not the contract, offers nothing (fail closed). The list is reused for five seconds at most.
- Without an offered-models reader wired (today: none) nothing changes: every step runs on `ROVARA_CORE_AGENT_MODEL`.
- Every routed model call is refused locally when the conversation holds tool calls or results and declares no tools (Converse needs a tool configuration and the gateway refuses such a turn). See `packages/model-runtime/src/tool-history.ts`; the e2e model channel contract requires tools with tool blocks too.

## What Cloud must publish (not built; no gateway API offers it yet)

Contract: `OfferedAgentModels` in `packages/contracts/src/agent-model-choice.ts`:

```json
{ "version": 1, "models": [ { "model": "claude-sonnet-5-5" }, { "model": "qwen.qwen3-coder-480b-a35b-v1:0" } ] }
```

- Each `model` is named exactly as the gateway's agent route accepts it: the engine name for Claude (`claude-haiku-5-5`), the Bedrock model or `us.` profile id for every other model (`us.amazon.nova-2-lite-v1:0`). One name is one model. At most 64, never empty, no duplicates.
- Per company, strongly consistent with what the agent route will accept for that company on its very next call: the company's AI source decides it (Rovara's AI offers the Claude names plus `ROVARA_AI_US_CONVERSE_MODELS`; the company's own Anthropic key offers Claude only; nothing saved offers what company-key mode accepts). A model the account has not enabled (Marketplace gated: Sonnet 5.5, Opus 5.5, Fable 5.2 answer `model_not_enabled`) should be left off the list until it is enabled, so no one can choose a model that cannot run.
- A service-to-service read by company id, authenticated like the task-token routes (the broker signs, the gateway checks); suggested `GET /v1/internal/companies/<companyId>/offered-models`. It answers a refusal, never an empty list, when the company has no source.
- Code then wires an HTTP `OfferedModelsReader` (`core-host/gateway-model-selection.ts`) into the broker root (`offeredModels` input of `createBrokerCoreRoot`) and the dispatcher (`offeredModels` of `createDispatcherCoreHost`). Both must use the same reader: the dispatcher chooses each step's model.
- "Web page only" means a fresh step-up proven by the verified token (as the decision cards): a CLI token issued right after a step-up would pass; requiring a registered web client as well is a follow-up.
- Cloud's web page shows the picker from `offered` and sends the change to Code's `POST /v1/app/agent-models` after its sign-in step-up.
