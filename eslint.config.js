import js from "@eslint/js";
import globals from "globals";

const sharedRules = { "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }] };

export default [
  { ignores: ["**/dist/**", "**/node_modules/**", "**/logs/**", ".tmp/**"] },
  js.configs.recommended,
  {
    files: ["client/src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: sharedRules,
  },
  {
    files: ["shared/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: sharedRules,
  },
  {
    files: [
      "server/**/*.{js,mjs}",
      "client/test/**/*.{js,mjs}",
      "client/vite.config.js",
      "scripts/**/*.{js,mjs}",
      "*.{js,mjs}",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, WebSocket: "readonly" },
    },
    rules: sharedRules,
  },
];
