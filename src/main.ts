import { Application } from "./app/index.js";
import { enableRuntimeDiagnostics } from "./shared/index.js";

enableRuntimeDiagnostics();

const application = new Application();
await application.start();
