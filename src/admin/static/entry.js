// LLM Proxy admin UI -- ES module entry point of the browser bundle.
// This file is the root the bundler walks: `/static/app.js` is this module graph and
// nothing else, so the page has no classic script scope left to reach into.

import { startAdminUi } from "./modules/wiring.js";

// The bundle is served as the last script of `index.html`, so the DOM this mounts into is
// already parsed. Everything else happens through imports: no module assigns a business
// function to a global, and the only global written anywhere is the test adapter's own
// namespace (see `modules/test-adapter.js`).
startAdminUi();
