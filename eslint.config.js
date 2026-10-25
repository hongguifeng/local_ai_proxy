import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import { readFileSync } from "node:fs";
import tseslint from "typescript-eslint";

/**
 * The browser APIs the admin UI references. Listed by hand rather than taken from an
 * environment preset so a misspelled API name is still reported as no-undef.
 */
const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  location: "readonly",
  history: "readonly",
  localStorage: "readonly",
  fetch: "readonly",
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  AbortController: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  Blob: "readonly",
  FormData: "readonly",
  FileReader: "readonly",
  TextEncoder: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  MutationObserver: "readonly",
  ResizeObserver: "readonly",
  IntersectionObserver: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  Node: "readonly",
  Element: "readonly",
  HTMLElement: "readonly",
  HTMLInputElement: "readonly",
  HTMLSelectElement: "readonly",
  HTMLButtonElement: "readonly",
  HTMLFormElement: "readonly",
  HTMLDialogElement: "readonly",
  HTMLDetailsElement: "readonly",
  KeyboardEvent: "readonly",
  PointerEvent: "readonly",
  ToggleEvent: "readonly",
  FocusEvent: "readonly",
  getComputedStyle: "readonly",
  matchMedia: "readonly",
  performance: "readonly",
  Intl: "readonly",
  structuredClone: "readonly",
  CSS: "readonly",
  crypto: "readonly",
};

/**
 * The capabilities the AI-17 transition bridge publishes, read from the place that
 * actually publishes them. `src/admin/static/entry.js` holds the list and assigns exactly
 * those names on `globalThis`, so ESLint cannot trust a name the browser never gets, and
 * a name it does not trust shows up as no-undef in the concatenated script. The list is
 * pinned by `test-node/admin/static-bridge.test.ts`; the bridge is removed before AI-19.
 */
const adminBridgeCapabilities = Object.fromEntries(
  [
    ...readFileSync(new URL("./src/admin/static/entry.js", import.meta.url), "utf8").matchAll(
      /^globalThis\.([A-Za-z0-9_$]+) = [A-Za-z0-9_$]+;$/gm,
    ),
  ].map(([, name]) => [name, "readonly"]),
);

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "dist-electron/**",
      "dist-node/**",
      "node_modules/**",
      "llm_proxy/static/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: ["**/*.ts"] })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({ ...config, files: ["**/*.ts"] })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-magic-numbers": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowBoolean: true, allowNullish: true, allowNumber: true },
      ],
    },
  },
  {
    // The module side of the admin UI: real ES modules, so every name has to be imported
    // or be a browser API. The bridge capabilities are deliberately absent, which is what
    // stops a module from reading a global instead of importing its sibling.
    files: ["src/admin/static/entry.js", "src/admin/static/modules/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: browserGlobals,
    },
  },
  {
    // The admin UI is a set of classic browser scripts: they run in global scope on
    // purpose and are concatenated by the server, so module-only rules do not apply.
    // The globals below are the ones these scripts actually reference, listed so a
    // typo in a browser API name still shows up as no-undef.
    files: [".ui-check/app.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...browserGlobals,
        ...adminBridgeCapabilities,
        // Not a browser API: the server substitutes this identifier into the
        // concatenated script before it is served (see static-assets.ts).
        __SUGGESTED_STRIP_REQUEST_FIELDS__: "readonly",
      },
    },
    rules: {
      "no-implicit-globals": "off",
    },
  },
  prettier,
);
