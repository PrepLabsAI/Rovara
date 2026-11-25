// What a sign-in client may do on Rovara as the signed-in person, beyond the access check (spec 065). An administrator names them when registering the client; the client asks for them at sign-in
// and its tokens carry the allowed ones. Plan v3.2 lane ID: each /v1/dev/* route needs one of them (the route table, routes.ts), or full access. A scope only narrows what the person may do; it
// never adds a right. The list moved here from packages/contracts/src/sign-in-clients.ts so the route table has no import pointing outward; contracts re-exports it.
export const CLIENT_SCOPES = [
  "projects:members", "projects:create",
  "profile:name", "tasks:read", "tasks:start", "tasks:act", "tasks:share", "decisions:decide",
] as const;

export type ClientScope = (typeof CLIENT_SCOPES)[number];
