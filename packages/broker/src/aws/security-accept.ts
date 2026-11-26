// The old workflow route `POST /v1/dev/tasks/{id}/workflow/review-findings` (DEC 236h): accepting a SECURITY review finding is the web page's alone, the Rovara web app's own full-access session (DEC 254zzz73:
// no step-up). The Rovara CLI's token, an AI tool's token, a scoped sign-in client's token and ANOTHER full-access client's token (the caller's own `webApp` is absent) may still accept the code review's findings,
// and fix any finding, as before.
//   - What makes a caller the page: the sign-in client the operator marked `webApp` (full access, spec 066; the marker is never set by an administrator's registration), read from its registration in the
//     sign-in step, never from a header, a query or a body. No other caller is the page, whatever it sends. Who may accept (the task's owner) is the route's own rule, unchanged.
// The refusals use fixed words and never echo anything the request carried. The same rule is the core engine's (`core/task-flow/security-accept.ts`).


