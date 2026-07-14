import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Security-aware linting (OSS Readiness Plan, Part 4.3). Recommended is
  // warn-level, so findings surface in CI without blocking; ratchet warn->error
  // once existing findings are burned down (Part 2, §2.4).
  security.configs.recommended,
  {
    rules: {
      // A leading underscore marks an intentionally-unused binding (discarded
      // destructure keys, no-op callback params).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
