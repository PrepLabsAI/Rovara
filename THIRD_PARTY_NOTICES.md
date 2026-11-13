# Third-party notices

Rovara includes the following third-party work in its source. Open-source packages that
are bundled into the Rovara Code CLI are listed separately, with their license texts, in
the `THIRD_PARTY_NOTICES` file of that package.

## Elephant-Goldfish Model (design review prompts)

- Project: Elephant-Goldfish Model, https://github.com/google/elephant-goldfish-model
- Commit adapted from: `464db031e`
- Copyright 2026 Google LLC
- License: Apache License, Version 2.0 (the text is in `LICENSE-APACHE`; the standard
  text is also at http://www.apache.org/licenses/LICENSE-2.0)
- Used in: `packages/core/src/core/design-review/prompts/` (the role prompts for design review)
- Modified by Rovara (PrepLabsAI). The prompts are adapted for an asynchronous review with
  strict structured output. The full attribution and the list of changes are in
  `packages/core/src/core/design-review/prompts/NOTICE`, and each adapted file begins with
  its own attribution header.

The upstream project ships no NOTICE file of its own (checked at the commit above).
