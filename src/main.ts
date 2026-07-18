import { createNodeApplication } from "./app/index.js";
import { installShutdownSignals, openBrowserLater, parseCliArgs } from "./cli/index.js";
import { enableRuntimeDiagnostics } from "./shared/index.js";

enableRuntimeDiagnostics();

const options = parseCliArgs(process.argv.slice(2));
const { application } = createNodeApplication(options);
await application.start();
installShutdownSignals(application);
if (!options.noBrowser) {
  openBrowserLater(`http://${options.host}:${options.port}`);
}
