import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const unusedVars = [
  "error",
  { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
];

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/logs/**", ".tmp/**"],
  },
  js.configs.recommended,

  // Plain JS/MJS that is left (config files, small tools).
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { "no-unused-vars": unusedVars },
  },

  // All TypeScript: type-checked rules, so the linter knows what a Promise is.
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": unusedVars,
      // Casts are budgeted (see README, "What TypeScript found"): each one needs a reason.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      // `() => bus.emit(...)` style callbacks are idiomatic here.
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        {
          ignoreArrowShorthand: true,
          ignoreVoidOperator: true,
          ignoreVoidReturningFunctions: true,
        },
      ],
      // Template strings with numbers are fine in logs and labels.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    files: ["client/**/*.ts"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["shared/**/*.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["server/**/*.ts", "scripts/**/*.ts", "client/vite.config.ts"],
    languageOptions: { globals: { ...globals.node } },
  },
  // node:test's test()/describe() return promises that the runner itself awaits.
  {
    files: ["**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
