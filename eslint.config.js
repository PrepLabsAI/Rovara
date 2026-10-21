import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

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
      "tests/fixtures/e2e-accounts-app/**",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.lint.json",
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
