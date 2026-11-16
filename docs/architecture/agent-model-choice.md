# Agents pick the models Rovara's AI serves

DEC 243c (Rovara's AI offers every Bedrock coding model, not only Claude), DEC 236j (model choices are made on the web page only, after a fresh step-up) and DEC 240 (the customer pays for Rovara's AI).

## What Code does

- A company chooses the model each step of its agents runs on (the same per-step rule the laptop has: understand, plan, build, the checks, the pull request step) on the web page, from the models the gateway offers THAT company.
  - `GET /v1/app/agent-models`: any member reads the setting and the whole offered list (`AgentModelPage`: `state` plus `offered`).
  - `POST /v1/app/agent-models`: the change (`ModelSelectionBody`). Only right after a fresh step-up the route checks itself (an API token or script token has none and is refused in fixed words), only by an owner or administrator (live role from membership), and only for a model on the offered list now. A less-safe change still needs the company's approval rule.
  - The choice is the company's own `MODEL_SELECTION_POLICY` row (company-keyed). Project-level choices are not built (the laptop rule has none either).
- The core engine runs every step on the model the rule chooses, always through the gateway's agent route (`/v1/messages`, Anthropic Messages) with the model's own name as the alias and as the catalog entry. A model that is not on the offered list is never CHOSEN for a step: the step ends before any machine starts, with fixed words. Two things keep what they hold, because the gateway checks the company's source and meters every call anyway: a step that already holds its choice (a repeat delivery after the model left the list), and an operation with no model step of its own (it runs on the default model). With nothing chosen a step runs on the install's default model (`ROVARA_CORE_AGENT_MODEL`), as before, and is refused the same way if that model is no longer offered.
- A list that cannot be read, or is not the contract, offers nothing (fail closed). The list is reused for five seconds at most.
- Without an offered-models reader (the gateway not configured, or no task-token signer) nothing changes: every step runs on `ROVARA_CORE_AGENT_MODEL`.
- Every routed model call is refused locally when the conversation holds tool calls or results and declares no tools (Converse needs a tool configuration and the gateway refuses such a turn). See `packages/model-runtime/src/tool-history.ts`; the e2e model channel contract requires tools with tool blocks too.

## The gateway's list (Cloud #72)

Cloud's gateway serves `GET <ROVARA_CORE_MODEL_GATEWAY_URL>/v1/service/companies/<companyId>/offered-models` (Cloud `docs/model-gateway-offered-models.md`), answering the `OfferedAgentModels` contract in `packages/contracts/src/agent-model-choice.ts`: 1 to 64 names, each exactly as the agent route accepts it (the engine name for Claude, the Bedrock id for the rest), one name per model.

Code reads it with `core-host/offered-models-http.ts`:

- a service token the broker signs with the install's task key: header exactly `{alg: RS256, typ: "rovara-service+jwt", kid}`; claims exactly `iss` (the install's issuer), `aud: "rovara-model-gateway-offered-models"`, `jti` (UUID), `iat`, `nbf = iat - 30`, `exp = iat + 60`, `cid`. A fresh token for every call.
- the company in the path is the company in the token, and is a checked company id before anything is signed or sent. A bodiless GET, no query, no other credential, no redirects.
- anything but a 200 whose body is the contract (within 64 KiB and 4 s) is a failed read: nothing is offered. The failure says fixed words only.
- one reader for every company, built from the environment only where `ROVARA_CORE_MODEL_GATEWAY_URL` is configured and the install has a task-token signer and issuer. The broker root builds it by itself; the dispatcher builds the same one.

**The dispatcher cannot sign yet.** The task key's policy lets only the broker's role sign (`SignOnlyAsBroker`), and the dispatcher function has no `TASK_TOKEN_KEY_ARN`. The dispatcher chooses each step's model, so until infrastructure lets it sign (or the broker signs for it) its reader is none and every step still runs on `ROVARA_CORE_AGENT_MODEL`, even if the page has saved another choice. Do not offer the picker to a company before then.

- Cloud's web page shows the picker from `offered` and sends the change to Code's `POST /v1/app/agent-models` after its sign-in step-up.
- "Web page only" means a fresh step-up proven by the verified token (as the decision cards): a CLI token issued right after a step-up would pass; requiring a registered web client as well is a follow-up.
