// The refusal codes, their statuses and the error envelope moved to @preplabsai/rovara-code-api (packages/code-api/src/errors.ts, F3 cut 1), the one place they are written. This file
// re-exports them under the same names, so every importer in this repository is unchanged.
export * from "@preplabsai/rovara-code-api/errors";
