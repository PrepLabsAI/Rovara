# Implementation Plan: Channel adapters in production

## Where things live

| Part | Today | Change |
| --- | --- | --- |
| `infra/lib/control-plane.ts:121` | `signInParameters` only for named environments | also for the legacy deployment |
| `infra/lib/control-plane.ts:856` | `DeveloperSignIn` and the developer-task features made together, named only | `DeveloperSignIn` made in both; the task workflow, notifier, ChatGPT and task-person parts stay named only |
| `infra/lib/control-plane.ts:848` | `registry: naming.env !== undefined` | `registry: true` (still behind `ChannelAdapters`) |
| `infra/lib/naming.ts` | legacy naming already has `developerTokenKeyAlias` | nothing; the OIDC secret is `agentx/production/developer-oidc` |
| broker `developerConfiguration` | serves the whole developer API once sign-in is set | the legacy deployment serves only linking, the access check and sign-in clients (`DEVELOPER_API_SCOPE=linking`) |
| broker admin changes | refused in the legacy deployment | adapter kinds allowed there (`ADMIN_CHANGES=adapters`) |
| CLI `adapter …` | needs a named environment | works for an adopted legacy deployment |

## Phases

| Phase | What | Production effect |
| --- | --- | --- |
| 064a | Sign-in and the adapter registry in the legacy templates; the broker serves only the linking part of the developer API there | New resources, off by default; the template check shows nothing removed or replaced |
| 064b | The sign-in client admin changes in the legacy deployment, confirmed in the CLI (adapters need none: their commands use `/v1/admin/channels`, served once `ChannelAdapters` is on) | None until a client is registered |
| 064c | Turn on: set the sign-in parameters (Cognito) and `ChannelAdapters=enabled`, register a test adapter, link, and prove #437 and #438 | Adapters live |

## 064c as done (2026-11-13)

`agentx signin enable` refuses the legacy deployment, so sign-in was set up by hand:

1. Cognito group `rovara-developers`, and app client `rovara-developer-signin` in production's pool, with a secret, the
   `code` flow, scopes `openid email profile`, and callback `<api>/v1/auth/callback/oidc`.
2. Its secret in `agentx/production/developer-oidc` as `{"clientSecret": ...}`.
3. One change set on `AgentXControlPlane`: `DeveloperOidcIssuer` (the pool), `DeveloperOidcClientId`,
   `DeveloperOidcRequiredClaim=cognito:groups`, `DeveloperOidcRequiredValues=["agentx-admin","rovara-developers"]` (the
   pool allows self sign-up; this keeps self-made accounts out), `DeveloperOidcDisplayName`, `DeveloperOidcSince`, and
   `ChannelAdapters=enabled`.

## Decisions

- **Login for linking:** production's existing Cognito pool (`us-east-1_o1RxnoU3F`), the one admins already use. People
  who will link are added to it by an administrator. Slack sign-in is left for later, since it needs a change to the
  production Slack app.
- **Narrow developer API:** the legacy deployment has none of the developer-task tables or permissions, so serving the
  whole API there would expose routes that fail. It serves only what linking needs.
- **AGENTX_ENV:** the broker and the sign-in Lambda take `production` as their environment name. It appears in token
  issuers and secret names, never in stack names.
