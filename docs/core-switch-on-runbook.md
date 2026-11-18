# Core switch-on rehearsal — staging only

Release owner: 9d. This document is a procedure, not evidence that staging passed. No account identifiers, credentials, private keys or tokens belong in its evidence. Keep provider keys in the existing company connection UI and token material out of logs.

**HOLD:** do not enable the core switch until every step below is done. `CORE_ENGINE_BROKER_WIRED` is now true (L6, #791): the CLI accepts `on`, `on:<company>` and `drain` for `coreEngine.switch`, and with the switch `off` (not draining) the broker reads no core setting and builds nothing (tested). The release still needs the rebuilt worker image and the staging routing proof (step 8). The two-company contract and the stored-choice tests pass on #791.

## Operator setup and review helpers

Use only the staging profile and existing staging stacks. Supply deployment-specific names locally; the placeholders below are not account identifiers. Never run this against the unnamed legacy/production stack.

```sh
export AWS_PROFILE="$STAGING_PROFILE"
export AWS_REGION=us-west-2
export CORE_STACK=agentx-staging-control-plane
export CORE_COMPANY="$FOUNDERS_COMPANY"
export CORE_MODEL="$REVIEWED_ANTHROPIC_MODEL"
export CORE_GATEWAY="$STAGING_GATEWAY_ORIGIN"
# Previews upload their template here: the CDK bootstrap assets bucket, where cdk deploy uploads templates too (qualifier hnb659fds).
export CORE_ASSETS_BUCKET="cdk-hnb659fds-assets-$STAGING_ACCOUNT-$AWS_REGION"
mkdir -p "$REHEARSAL_DIR"
aws cloudformation get-template --stack-name "$CORE_STACK" --template-stage Original > "$REHEARSAL_DIR/template-readback.json"
jq '.TemplateBody | if type == "string" then fromjson else . end' "$REHEARSAL_DIR/template-readback.json" > "$REHEARSAL_DIR/before.json"
cp "$REHEARSAL_DIR/before.json" "$REHEARSAL_DIR/next.json"
aws cloudformation describe-stacks --stack-name "$CORE_STACK" --query 'Stacks[0].Parameters[].{ParameterKey:ParameterKey,UsePreviousValue:`true`}' > "$REHEARSAL_DIR/previous-parameters.json"
cp "$REHEARSAL_DIR/previous-parameters.json" "$REHEARSAL_DIR/next-parameters.json"
```

The following helpers prepare a change set; they do not execute it. Retain every unrelated parameter and environment entry. Base a code deployment on 9d's packaged, reviewed template, then apply the same overlays to that template. Do not replace packaged code with the older template saved above.

```sh
core_parameter() {
  jq --arg key "$1" --arg value "$2" 'if any(.[]; .ParameterKey == $key) then map(if .ParameterKey == $key then {ParameterKey:$key,ParameterValue:$value} else . end) else error("unknown existing parameter") end' \
    "$REHEARSAL_DIR/next-parameters.json" > "$REHEARSAL_DIR/parameters-new.json"
  mv "$REHEARSAL_DIR/parameters-new.json" "$REHEARSAL_DIR/next-parameters.json"
}
core_environment() {
  jq --arg key "$1" --arg value "$2" --arg targets "$3" '
    .Resources |= with_entries(if .value.Type == "AWS::Lambda::Function" and (.key | test($targets))
      then .value.Properties.Environment.Variables[$key] = $value else . end)' \
    "$REHEARSAL_DIR/next.json" > "$REHEARSAL_DIR/template-new.json"
  mv "$REHEARSAL_DIR/template-new.json" "$REHEARSAL_DIR/next.json"
}
# The control-plane template is about 218 KB, over CloudFormation's 51,200-byte limit for --template-body, so the preview uploads it (minified) to the
# assets bucket and passes --template-url, as cdk deploy does. This is an S3 write under its own prefix; delete the object with the change set.
core_preview() {
  local key="core-switch-on-preview/$1.template.json"
  jq -c . "$REHEARSAL_DIR/next.json" > "$REHEARSAL_DIR/$1.template.json"
  aws s3 cp "$REHEARSAL_DIR/$1.template.json" "s3://$CORE_ASSETS_BUCKET/$key" --only-show-errors
  aws cloudformation create-change-set --stack-name "$CORE_STACK" --change-set-name "$1" \
    --change-set-type UPDATE --template-url "https://$CORE_ASSETS_BUCKET.s3.$AWS_REGION.amazonaws.com/$key" \
    --parameters "file://$REHEARSAL_DIR/next-parameters.json" --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
  aws cloudformation wait change-set-create-complete --stack-name "$CORE_STACK" --change-set-name "$1"
  aws cloudformation describe-change-set --stack-name "$CORE_STACK" --change-set-name "$1" --query '{Status:Status,Changes:Changes}'
}
# After review (and after executing or deleting the change set): aws s3 rm "s3://$CORE_ASSETS_BUCKET/core-switch-on-preview/<name>.template.json"
```

9d reviews each preview before `aws cloudformation execute-change-set --stack-name "$CORE_STACK" --change-set-name "$CHANGE_SET"`. Read back with `aws cloudformation get-template --stack-name "$CORE_STACK"` and `aws cloudformation describe-stacks --stack-name "$CORE_STACK" --query 'Stacks[0].Parameters'`. Any unexpected IAM delta, replacement or production resource is a stop. The baseline template/parameters are the rollback inputs; use a reviewed rollback change set rather than overwriting a running stack blindly.

## Ordered readiness steps

1. **Task key, issuer and JWKS first.** Deploy the reviewed named-environment task-key/JWKS infrastructure before setting `coreEngine.modelGatewayUrl` (step 2). `TASK_TOKEN_KEY_ARN` is generated by `DeveloperSignIn`, not a new operator parameter. Confirm its existing broker name mapping and the sign-in Lambda's environment; do not create another key or grant. Confirm `DEVELOPER_TOKEN_ISSUER` matches the gateway's pinned issuer. Read the issuer's `/v1/auth/.well-known/jwks.json` and require the published task key's `rovara_purpose=task`, RS256, stable kid and matching public material. Verify the gateway's existing company mode pins that issuer, JWKS and task kid. Preview: task key/JWKS in the reviewed deployment change set and a public JWKS readback. Rollback: remove gateway model access first, drain tasks, then restore the prior key publication/configuration; retain keys while issued tokens remain usable. A gateway URL without a task signer refuses the whole company runtime.

2. **Gateway URL and identical agent model — CONFIG.** Two stack parameters of the control plane, `CoreModelGatewayHost` (the gateway's host; the functions read `https://<host>`) and `CoreAgentModel` (default empty), set `ROVARA_CORE_MODEL_GATEWAY_URL` and `ROVARA_CORE_AGENT_MODEL` on BOTH the broker and the dispatcher (packed in their `AGENTX_SETTINGS`, `gw` and `am`; the broker's environment has no room for two more variables). They are `agentx config set` keys, `coreEngine.modelGatewayUrl` and `coreEngine.agentModel`, and `agentx upgrade` keeps their deployed values like the other core settings, so no template overlay is needed and an upgrade no longer drops them. Both are needed: with either empty the core refuses work by name, as today.

   The CLI checks each value before any deploy: the URL must be an https origin with no user name, password, path, query or fragment, and a host of at most 56 characters (stored as that host); the model must be an Anthropic id this release's model catalog knows (`claude-...`, never the Bedrock `us.anthropic....` id: the gateway maps it to the company's own key or BYO Bedrock role), or (DEC 254g) ANY model the gateway offers, by its exact id, such as `zai.glm-5`: Code holds no list. A non-Claude id is checked against the gateway's LIVE offered-models answer for your company before any deploy (`GET /v1/admin/core/offered-models` on the broker, with your admin sign-in, so run `agentx --env staging login --admin` first and set `coreEngine.modelGatewayUrl` before the model); an id the gateway does not offer, an unreachable gateway or no admin sign-in refuses the change. The stack parameter's own pattern only admits a well-formed id (lowercase letters, digits and `. _ : -`, at most 64 characters). At run time the gateway stays the authority: a model it no longer offers fails the step as `model-not-found ModelNotOffered`.

   ```sh
   # Preview first (config set without a terminal applies; never preview with it):
   CORE_GATEWAY_HOST="${CORE_GATEWAY#https://}"; CORE_GATEWAY_HOST="${CORE_GATEWAY_HOST%/}"   # the host only, lowercase, no trailing slash
   core_parameter CoreModelGatewayHost "$CORE_GATEWAY_HOST"
   core_parameter CoreAgentModel "$CORE_MODEL"
   core_preview l6-model-access
   # After review, apply in a terminal. Each command shows its own change set and asks; set both before step 16.
   agentx --env staging config set coreEngine.modelGatewayUrl "$CORE_GATEWAY"
   agentx --env staging config set coreEngine.agentModel "$CORE_MODEL"
   agentx --env staging config get coreEngine.modelGatewayUrl
   agentx --env staging config get coreEngine.agentModel
   ```

   The release that adds these parameters deploys them empty on its first upgrade. If staging carried the older template overlays, that upgrade removes them: set the switch to `drain` (and wait for no in-flight core work) or `off` BEFORE that upgrade if the overlays are live, then run the two `config set` commands right after it. Every later upgrade keeps them.

   Preview/readback: only the broker's and the dispatcher's environments change (Modify, no replacement, no IAM); both have the same HTTPS origin and agent model id. The agent model is an Anthropic id or (DEC 254g) any model the gateway offers, by its exact id; on staging, while Bedrock's Claude models are not enabled, it is `zai.glm-5` (GLM-5, the strongest GLM the gateway offers and prices). Rollback (after drain): `agentx --env staging config set coreEngine.modelGatewayUrl none` and `agentx --env staging config set coreEngine.agentModel none`, which put both back to empty.

   **Optional, any time after this step (L4-AM, DEC 254zzn(2)): a dedicated hosted answers model.** One more stack parameter of the control plane, `CoreAnswersModel` (default EMPTY), sets `ROVARA_CORE_ANSWERS_MODEL` on the BROKER only (packed `aa` in its `AGENTX_SETTINGS`; the dispatcher has no piece of it and no IAM or secret changes). Empty: the hosted Just answer and the start-box classifier run on the agent model, exactly as before. Set (`agentx --env staging config set coreEngine.answersModel claude-haiku-5-5`, kept across upgrades): only those two use it; coding tasks keep `coreEngine.agentModel`. It must be an Anthropic id the catalog knows (the answers purpose runs on the company's own Anthropic account), so it also lets answers work while the agent model is a non-Claude model such as `zai.glm-5`. Preview as above (`core_parameter CoreAnswersModel claude-haiku-5-5`, `core_preview`): only the broker's environment changes (Modify, no replacement, no IAM). Rollback: `config set coreEngine.answersModel none`.

   **Optional, any time after this step (DEC 254zzz58/63): the hosted lessons learning model.** One more stack parameter of the control plane, `CoreLearningModel` (default EMPTY), sets `ROVARA_CORE_LEARNING_MODEL` on the BROKER only (packed `lm` in its `AGENTX_SETTINGS`; the dispatcher has no piece of it and no IAM or secret changes). Lessons never learn on the agent model. Empty: they learn with `claude-haiku-5-5` (Claude Haiku 5.5). Set (`agentx --env staging config set coreEngine.learningModel claude-sonnet-5-5`, kept across upgrades): it is the install default. A company's owners or admins may choose their own learning model in the company's AI settings (`PUT /v1/dev/company/learning-model`, a Claude model the gateway offers the company), which wins for that company. Every learning call runs on the company's own Anthropic account inside its caps; a company without it connected sees "Lessons paused: no AI provider is connected for this project". Preview as above (`core_parameter CoreLearningModel claude-sonnet-5-5`, `core_preview`): only the broker's environment changes (Modify, no replacement, no IAM). Rollback: `config set coreEngine.learningModel none`.

   **PROOF — after step 16, unattended still off:** with the worker image from step 8, each model request uses the URL/key pair from the current authenticated GET `/v1/internal/model-access` answer. Covered workspaces receive the gateway URL and own-company task token; uncovered ones retain today's broker answer/proxy. A core route asks the broker even with no boot proxy URL. Invalid/absent answer URL falls back to the existing boot value, or refuses with fixed words when none exists. No shared launch-template, global worker proxy, per-job environment or IAM change is needed. Preview/readback: require `model.route`, prove worker egress to the gateway, observe the covered worker's chosen URL and own-company token claims without logging tokens, then prove an uncovered worker still chooses its prior proxy. Test no boot value and an invalid answer as well. `?slot=` and core second-reviewer operations refuse. No user authorizer applies to this exact GET on named installs. Rollback: drain and restore the previous reviewed worker image together with gateway settings; leave boot settings unchanged.

3. **Agent model choice (ANSWER-3; default OFF) — CONFIG.** Keep `ROVARA_CORE_AGENT_MODEL_CHOICE` unset or `off` on the broker until its offered-models route is qualified. The broker setting alone turns model choice on: only the broker signs service tokens and reads the company's offered list; it validates saved choices and stores `agentModelValidation` on that company's existing `MODEL_SELECTION_POLICY` row in State. The dispatcher reads no choice setting. It uses a fresh, company-scoped validated row when one exists; without a fresh row it uses the configured default model. The dispatcher gets no task-signing grant or `TASK_TOKEN_KEY_ARN`.

   Since the live switches check (2026-11-18) it is the control plane's stack parameter `CoreAgentModelChoice` (`off`, the default, or `on`), packed for the broker only (`mx`) and kept
   across upgrades; the template overlay is no longer used.

   ```sh
   core_parameter CoreAgentModelChoice on
   core_preview l6-model-choice-on
   # Enable after step 16; prove below with unattended still off:
   agentx --env staging config set coreEngine.agentModelChoice on
   agentx --env staging config get coreEngine.agentModelChoice
   ```

   Preview/readback: only the broker's environment changes (Modify, no replacement, no IAM): its AGENTX_SETTINGS `mx=on`. Rollback: `agentx --env staging config set coreEngine.agentModelChoice off`, then verify the original default route. The choice may stay on through drain; broker validation continues to refresh for companies with tasks still on the core.

   **PROOF — after step 16, unattended still off:** prove the offered-models route is qualified. Through the existing page, save an offered model as a signed-in owner or admin; prove the company's stored validation and a dispatched step use it, with no dispatcher HTTP list request. The broker refreshes validation before outbox handoff; dispatcher reads are consistent, use the company from the workspace record, and refuse mismatched or malformed validation in fixed words. Prove an unoffered choice is rejected, missing or expired validation uses the configured default (expiry logs one fixed-word event), and switch-off preserves the default model path. Do not log tokens or company policy contents. Keep the core draining while correcting invalid or unavailable choices. Watch the dispatcher's `core_engine.model_choice_expired` log count: each one is a step that ran on the install default instead of the company's choice (the stored choice is valid for 60 s; a slow queue makes these). A rising count means the broker isn't refreshing in time; turn the choice off on the broker (CONFIG rollback) until it is fixed.

4. **Founders' provider connection before productAi.** The founders' test company must connect its own Anthropic key in the gateway's existing company connection UI before gateway `productAi` is enabled. Verify connection/budget status without displaying the key; a missing key must stop clearly as `no_ai_key`. Gateway `productAi` is not a Code CLI key or stack parameter. Its exact enable/disable command must come from the gateway owner's reviewed deployment procedure; that external operation remains a prerequisite, not a guessed Code command. Preview: gateway owner's configuration diff and own-company connection status. Rollback: disable `productAi` through the same gateway procedure, then remove the company connection only after draining.

5. **Set a low provider spend limit for the window.** Record the AI provider account's low hard spend limit and the founders' company budget before any paid test. Use the provider's existing administrative UI/procedure; Code's admission caps do not replace that limit. Preview: owner readback of the limit, with no account identifier or key. Rollback: keep the low limit through drain, then restore the recorded prior limit only after the rehearsal ends.

6. **L4 backfill: installation bindings FIRST.** Use the existing operator runner, with reviewed JSON mapping files containing company id, projectNames, bindings, people and grants. First apply a bindings-only map with empty projectNames, then backfill projects/people/grants; continue every bounded page using its returned continuation. Map unowned legacy projects **only to the implicit company**, or have L4 bind their legacy ownership before using a different mapped company. Never create a split between future registrations and backfilled history.

   ```sh
   node packages/broker/dist/aws/core-backfill-runner.js --state-table "$STATE_TABLE" --signin-table "$SIGNIN_TABLE" --input "$BINDINGS_MAP"
   node packages/broker/dist/aws/core-backfill-runner.js --state-table "$STATE_TABLE" --signin-table "$SIGNIN_TABLE" --input "$BINDINGS_MAP" --apply
   node packages/broker/dist/aws/core-backfill-runner.js --state-table "$STATE_TABLE" --signin-table "$SIGNIN_TABLE" --input "$PROJECT_MAP"
   node packages/broker/dist/aws/core-backfill-runner.js --state-table "$STATE_TABLE" --signin-table "$SIGNIN_TABLE" --input "$PROJECT_MAP" --apply
   node packages/broker/dist/aws/core-backfill-runner.js --state-table "$STATE_TABLE" --signin-table "$SIGNIN_TABLE" --input "$PROJECT_MAP" --people-check
   ```

   Preview: default dry-run reports, then zero conflicts/refusals and completed continuations. Read back `GITHUB_INSTALLATION#<id>/BINDING`, company project revisions/catalog pointers, live memberships and grants. Verify FR-018 `developerTasks.enabled=false` refuses a core start and each company's catalog is authoritative. `share=required` refuses until core channel sharing exists. Operator grant reverse rows for member-list UI remain L4's deferred follow-up. Rollback: turn new core starts off via drain, retain copied rows and original legacy rows; no destructive backfill reversal during a rehearsal.

7. **Fast relay BEFORE unattended starts.** Deploy L9's reviewed mapping, then set the existing runtime flag on broker and dispatcher:

   ```sh
   core_environment ROVARA_CORE_OUTBOX_STREAM_RELAY on '^(Broker|Dispatcher)[A-F0-9]{8}$'
   core_preview l6-outbox-relay
   ```

   Preview/readback: L9's State stream mapping is enabled and company outbox dedupe works during overlapping retries (notifier 20 s, relay up to 50 s). Rollback: turn unattended triggers off first, drain; restore the flag's prior value and mapping through the reviewed template.

8. **Rebuild and qualify workers.** Release owner rebuilds the existing image and deploys its already supported image selection mechanism; L6 adds no launch-template setting. Read the worker feature handshake and require `task.usageCheckpoints.v1` as well as the model-routing capability approved by ANSWER-2. An older worker must refuse a model run with money stop on. Preview: reviewed image/release diff and feature readback. Rollback: unattended off, drain, restore the previous reviewed worker image selection; never bypass feature checks.

9. **Session sweep and notice delivery — CONFIG before step 16.** Review the existing schedules (session-sweep, notify-deliver and admission-hold-sweep) in the `CoreEngine` switch change set. Preview: schedules in the switch change set. No new schedule or IAM role is required.

   **PROOF — after step 16, unattended still off:** Prove their staging invocations complete and notices reach the founders' company without touching another company's queues. Readback: bounded company reports and successful delivery. Rollback: unattended off, drain, then CoreEngine off.

10. **First-deploy L9 filter check.** Inspect the deployed event-source mapping's `FilterCriteria` and verify the DynamoDB event filter's `anything-but` plus `prefix` shape is accepted and actually selects pending company outbox inserts. Send own-company and irrelevant staging fixtures and observe delivery/dedupe. Do not substitute a unit test for this AWS proof. Rollback: unattended off, drain, restore L9's last reviewed mapping; retain the existing scheduled backstop while draining.

11. **Dispatcher lessons — CONFIG before step 16.** Set the reviewed `CoreLessons` setting and inspect the existing role/policy. Preview: reviewed setting change set and role/policy review.

   **PROOF — after step 16, unattended still off:** Prove a real dispatcher invocation reads the exact lessons head/set/settings/source keys its own workspace requires. Test spoofed payload company and a foreign workspace: neither selects another company's lessons. Do not add grants to make this pass; any missing grant goes back to owner review. Readback: own-company load report. Rollback: `core_parameter CoreLessons off`, preview/apply that change set, drain any work that already pinned lessons.

12. **Stop flush — CONFIG before step 16.** Confirm the reviewed worker image and usage-checkpoint capability from step 8, and keep unattended triggers off. Preview: the worker image readback from step 8 and every unattended source shown disabled. Rollback: none needed (nothing changes in this step).

   **PROOF — after step 16, unattended still off:** On a running model step with usage checkpoints, press Stop. Prove worker usage flush, usage booking, run cancellation and hold settlement finish without `usageUnflushed`. Check close and an interrupted worker as well; incomplete usage retains the whole hold as estimated spend. This is staging-only evidence. Rollback: unattended off, drain; preserve holds/evidence rather than assuming missing usage cost zero.

13. **Founders-only allow-list and small caps, on BOTH functions.** The parameter accepts `all`, but do not use it until #737 and #743 are proven on staging. Set the existing parameters and inspect the packed broker/dispatcher settings:

   ```sh
   core_parameter CoreAllowedCompanies "$CORE_COMPANY"
   core_parameter CoreTaskCapUsd 1
   core_parameter CoreCompanyDayCapUsd 5
   core_parameter CoreLessons "on:$CORE_COMPANY"
   core_preview l6-founders-caps
   agentx --env staging config set limits.workspacesPerMember 1
   agentx --env staging config set limits.workspacesPerOrg 2
   agentx --env staging config get limits.workspacesPerMember
   agentx --env staging config get limits.workspacesPerOrg
   ```

   Preview: parameter change set and CLI's shown change; record the previous workspace settings first. Readback: both functions resolve the same allow-list/caps, another company cannot start on the core, and the current admin workspace setting applies to every new core start. Rollback: restore recorded workspace values with the same `agentx config set` keys; restore caps/allow-list only after drain. New core starts off must not affect the old path.

14. **Keep unattended triggers off until runStopWired is proven.** `runStopWiredFrom` is true only with `ROVARA_CORE_OUTBOX_STREAM_RELAY=on`; that flag is a declaration, not staging proof. Both direct and staged `automation.run` refuse while false. No separate runStopWired parameter is introduced. The PROOF parts of steps 2, 3, 9, 11 and 12 (run after step 16) and owner review must precede enabling any existing unattended trigger. Retain its disabled configuration/readback until then. Rollback: disable every enabled unattended source before changing relay or worker settings.

15. **Web marker and security accepts.** Seed only the reviewed webApp sign-in-client marker through the existing identity deployment/seed procedure; check server-owned marker readback, never a request-body/client label. **SECURITY-ACCEPT-PAGE-ROUTE remains OPEN (L11): the core has no page route that can accept a SECURITY finding.** Script/API tokens must refuse; do not add a route or let a token impersonate a page. Acceptance requires the actual web page (verified webApp marker) and the task owner or a co-owner; there is no step-up (DEC 254zzz73). Preview: identity seed review and refusal tests; rollback: restore/revoke the marker through the same identity procedure. Leave acceptance unavailable in this rehearsal.

16. **Switch on, founders only, after the CONFIG sections above.** The release carrying `CORE_ENGINE_BROKER_WIRED=true` (L6) must be installed first: before it, the CLI refuses every value but `off`. Switching on takes BOTH the switch and the allowed-companies list from step 13 (the default `none` refuses every company). Never `on` or `all` here (CORE-SWITCHON-MONEY-CAP-GUARD). Then:

   ```sh
   agentx --env staging config set coreEngine.switch "on:$CORE_COMPANY"
   agentx --env staging config get coreEngine.switch
   ```

   Preview the CLI's stack change set before applying. If the CLI refuses because the installed release predates the wired flag, stop: do not bypass it using the stack parameter. Check the named exact model-access GET, own-company task token, start/dispatch/callback/review/merge jobs, foreign-company refusals, and an uncovered company's old path. Then complete the preceding steps' PROOF sections in order with unattended sources still off until step 14 is satisfied.

## System-started runs (L4-P1, owner DEC 254zzl): separate from the steps above, default OFF

Rovara's own runs (the free setup re-check at task start, and the hourly `upkeep-night` job that starts each due project's nightly check) are behind ONE stack parameter, `CoreSystemRuns`: `off` (the default), `on`, or `on:<company id>[:<company id>]`. It is separate from the hidden Automation feature (triggers, chains, custom agents), which stays off on hosted. P1 starts no AI.

- With it `off`: no system starter or night service is built, the re-check at task start does not run, the system owner is refused by the access rule, the `upkeep-night` schedule (already in the schedule group) stays `DISABLED`, and the setup page's upkeep switch is told `available: false`.
- To turn it on (controller, staging first): `core_parameter CoreSystemRuns "on:$CORE_COMPANY"`. Preview the change set first: it must show only that parameter changing and the one schedule `upkeep-night` going from DISABLED to ENABLED. Readback: the next hourly pass inside 07:00-11:00 UTC starts only projects whose upkeep is ON, once a day each, as the project's system owner (`system_run.requested` in the audit log). Rollback: `core_parameter CoreSystemRuns off`; the next pass starts nothing.
- Proof on staging: press "Re-check setup" on a project (`POST /v1/app/projects/{p}/setup-check`, a person's check, no flag needed); then turn the flag on for the founders' company, switch one project's upkeep on, and watch one night.
- Machine time of system runs is attributed to the company and project (rows `SYSTEM_RUN_USAGE`), counted and not yet limited: no machine-minute meter or cap exists (the gap is in the PR body).

### Two locks (L4-P2, owner DEC 254zzt, option A)

`CoreSystemRuns` is now only the CEILING (what the operator allows). Rovara's automatic runs also need the COMPANY'S CONSENT: a stored row (`ORG#<company>#SYSTEM_RUNS` / `CONSENT`) written only by a live company owner or admin, through the setup step `PUT /v1/app/projects/{p}/upkeep { requestId, on: true, allowSystemRuns: true }`, which sets the consent and the project's upkeep switch in one transaction with an audit record for each (`system_runs.consent_set`, `upkeep.upkeep_switched`). Effective system runs = ceiling AND consent, read on every use (the task access rule, the re-check at task start and its retry on the dispatcher, the starter, the night, each wiki page). Taking either away stops the next step.

- Turning the ceiling on alone changes nothing for a company until its owner or admin consents. Withdraw: `allowSystemRuns: false` (with `on: false`), or the company route below.
- ALLOWING needs a live company owner or admin (the role, read for the request) and the ceiling; there is no step-up (DEC 254zzz73 replaced L4-P3's fresh step-up). WITHDRAWING needs only the role; on the company route it also works while the ceiling is off.
- The company's own control: `GET /v1/app/company/system-runs` answers `{ available, allowed, systemRunsOn }` and `PUT` takes `{ requestId, allowed }` (a live company owner or admin only; a script token never reaches it). Both audit as `system_runs.consent_set` (the person, the role and the choice), before the row. A withdrawal changes only the company's consent row: projects keep their switch (they read as off while the consent is off), and the next run is refused at once because the effective gate is read on every use. No infrastructure or IAM change.
- The dispatcher now also receives the packed `coreSystemRuns` value (environment only, no IAM): its setup gate before a build can retry a re-check, and that retry must stop when the flag goes off. The preview shows the dispatcher's AGENTX_SETTINGS changing in addition to the broker's.
- AI: the nightly wiki refresh (the only AI kind live) starts only where the registered Admission declares an enforced dollar cap (`enforcesCost`, the per-run stop wired), both locks are open, the project's upkeep is ON, Admission says yes (hold keyed by the night) and the audit record `system_run.requested` (kind `wiki_refresh`) is written first. Model calls carry the work origin `nightly`, so the gateway's upkeep cap (Cloud #125) counts them. The repair draft stays refused on hosted.
- The cap number is not stored in Code: `GET .../upkeep` answers `cap.monthlyUsd` from the gateway's cap read (below), and `null` where the gateway does not answer it.

### Nightly wiki refresh and the gateway's cap read (L4-SR1)

The nightly wiki refresh starts AI by itself, so it needs a POSITIVE signal that the gateway holds the project's `upkeep_month` cap, on top of both locks, the project's switch and the install's own per-run stop (the Admission). The signal is a service read on the gateway, the same family as the offered-models read: `GET <gateway>/v1/service/companies/<company>/upkeep/<project>` with a service token (aud `rovara-model-gateway-upkeep-cap`, signed with the task key), answering exactly `{ version: 1, company, project, month, enforced: true, limitMicros, spentMicros }` (`company` echoes the company the token named) (contracts/upkeep.ts `UpkeepCapReadSchema`). Anything else (no route, 404, a late, malformed, stale-month or other-project answer, no signer) is "not known" and starts NO AI: the night says `no_cost_cap` and nothing is held. The gateway's route is Cloud's (it does not exist in the Cloud repository yet: until it does, this install starts no nightly AI). A cap with no room ($0, or used up) is a pause read before any call: the admins get ONE notice per (company, project, month, reason) and the night's row records `pauseReason`. A gateway 422 `upkeep_paused` on a started run ends it `upkeep_paused`, writes the same one notice and records the reason on the night's row.
- Trust notes (REVIEW-1 Lows, accepted): the run's cost, and so the settle of its money hold, comes from usage the worker reported and Code priced (the same ledger the per-run stop reads); the gateway's own per-call meter of `src: nightly` remains the independent monthly cap. The spend row is written when the task is first seen ended, so usage batches booked after that are not in the line (display only; they still reach the ledger and the day's load). The cap read echoes the company and Code refuses an answer for another.
- Spend line: each finished nightly run writes ONE row `ORG#<company>#SYSTEM_RUN_SPEND#<month>` (project, kind `wiki_refresh`, task, how it ended) before its money hold is settled. The cost is what the install's own cost ledger booked for the run's task (the gateway's `x-rovara-cost-usd` header exists on the answers route only, never on the agent route this run uses). A cost that is not known (no total, an unpriced call, another currency) leaves the figure out and counts the run in `unknownRuns`; it is never 0. `GET .../upkeep` answers `spend: { month, spentUsd, runs, unknownRuns }` to people who manage the project ("Nightly upkeep: $spentUsd of $cap.monthlyUsd"; "at least" when `unknownRuns` is more than 0).

## Rollback: unattended off → drain → off

```sh
agentx --env staging config set coreEngine.switch drain
agentx --env staging config get coreEngine.switch
# Wait for zero in-flight core tasks, empty pending outboxes, settled/retained usage holds,
# and completed callback, sweep and notice obligations. Existing tasks keep their core stamp.
agentx --env staging config set coreEngine.switch off
agentx --env staging config get coreEngine.switch
```

Review both CLI change sets. Keep gateway keys, workers, relay and jobs available during drain. After zero in-flight work, verify schedules/dispatcher mapping are disabled, restore recorded runtime overlays, the gateway settings (step 2) and workspace settings, and confirm the off broker/dispatcher build nothing and read no new wiring inputs. No running core task is migrated to the old engine by switching off.

Open evidence remains: fresh contract and stored-choice file runs/gates/review by 9d; rebuilt worker routing/feature and model-choice staging proof; gateway owner's productAi procedure; provider spend-limit readback; L4 completed binding-first migration/people proof; L9 deployed filter and overlap/dedupe proof; worker rebuild/features; live scheduled passes; dispatcher lessons IAM; flushed Stop; L11 security-accept page route and reviewed web marker seed.
