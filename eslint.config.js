import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
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
  HTMLTextAreaElement: "readonly",
  HTMLSelectElement: "readonly",
  HTMLButtonElement: "readonly",
  HTMLFormElement: "readonly",
  HTMLDialogElement: "readonly",
  HTMLDetailsElement: "readonly",
  HTMLLabelElement: "readonly",
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
  globalThis: "readonly",
};

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
    // The whole admin UI is a set of real ES modules, so every name has to be imported or
    // be a browser API. Sibling modules are deliberately absent from this list, which is
    // what stops a module from reading a global instead of importing its sibling.
    files: ["src/admin/static/entry.js", "src/admin/static/modules/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...browserGlobals,
        // Not a browser API: the server substitutes this identifier into the served
        // script before the browser runs it (see static-assets.ts).
        __SUGGESTED_STRIP_REQUEST_FIELDS__: "readonly",
      },
    },
  },
  prettier,
);
