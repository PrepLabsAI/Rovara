# @preplabsai/rovara-code-api

The contracts of Rovara Code's API that a client may build against: the route table (`ROUTES`), the refusal codes and the error envelope (`errors.ts`), the client scopes, and the API version
(`CODE_API_VERSION`, `CODE_API_MIN_CLIENT`). Browser-safe: no `node:` import, and `zod` is the only peer dependency. Nothing here runs the engine.

Code owns this package. Cloud (and any other client) builds it from Code at a pinned commit; it is not published to npm.

## Skew

```
Additions go Code first: new rows, optional response fields, new codes. Cloud's readers ignore what they do not know, and Cloud cannot call a route until it pins a version that has it.
Removals and narrowings go Cloud first: Code marks the item deprecated and publishes N, Cloud pins at least N and stops using it, then Code raises CODE_API_MIN_CLIENT to N and removes it.
The deployed Cloud's drift gate refuses a Code whose CODE_API_MIN_CLIENT is above Cloud's pin; the candidate Cloud's pin must not be above the live Code's CODE_API_VERSION.
```

## Rules for a change here

- The refusal codes are append-only: no code changes meaning, none is removed or reordered (`tests/contract/code-api-errors.test.ts`).
- A change to the contract surface (a row that carries a schema or `webAppOnly`, the code list, `CODE_API_MIN_CLIENT`) needs a bump of `CODE_API_VERSION` and a new line in `tests/contract/code-api-version.test.ts`.
- A stored record is read tolerantly by every release that may run after a rollback, or the new facts go in a sibling attribute.
- Keep the package self-contained: its own `tsconfig.json` (no `extends` outside the folder), no import of any other Code file, no `node:` import. A test builds it the way a client's fetch script does.
