// Loads every API module the way production does (plain Node ESM through tsx, not vitest), so an import that
// only works under the test runner, such as a named import from a CommonJS package, fails CI instead of a deploy.
import "./config.js";
import "./container.js";
import "./server.js";
import "./routers/app-router.js";

process.stdout.write("api modules load\n");
