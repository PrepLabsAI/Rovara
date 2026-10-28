import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// `npm run lint` (scripts/lint-shards.ts) lints in shards so that the whole repository never sits in one heap. Each shard names its own, smaller
// TypeScript program (a tsconfig that extends tsconfig.lint.json) in LINT_SHARD_PROJECT. Run by hand (an editor, `npx eslint file`) it is not set
// and the whole repository is one program, as before. The rules and the ignores are the same for every shard.
const lintProject = process.env.LINT_SHARD_PROJECT || "./tsconfig.lint.json";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "cdk.out/**",
      ".release-synth/**",
      "coverage/**",
      "tests/fixtures/e2e-web-api-app/**",
      "packages/verifier/assets/qualification-app/**",
      "tests/fixtures/orders-web-starter/**",
      "tests/fixtures/orders-web-m14/**",
      "tests/fixtures/e2e-accounts-app/**",
      "tests/fixtures/e2e-inferred-web-app/**",
      "tests/fixtures/orders-web-m13/**",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: lintProject,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/require-await": "off"
    },
  },
);
