import { createCheckoutCache } from "../src/checkout-cache.js";
import { checkoutCacheRoot, legacyStorageRoot } from "../src/storage-paths.js";

const [command, ...args] = process.argv.slice(2);
const legacy = args.includes("--legacy");
const offline = args.includes("--offline");
const ids = args.filter((arg) => !["--legacy", "--offline"].includes(arg));
if (!["inventory", "evict"].includes(command) || (command === "inventory" ? ids.length !== 0 || offline : ids.length !== 1)) {
  console.error("Usage: npm run cache -- inventory [--legacy]\n       npm run cache -- evict [--legacy] --offline <inventory-id>\n--offline confirms you stopped the cache's server and closed its external terminals/editors/jobs. Eviction rechecks safety and preserves review/session state.");
  process.exitCode = 1;
} else {
  const cache = createCheckoutCache(legacy ? legacyStorageRoot() : checkoutCacheRoot());
  try {
    if (command === "inventory") console.log(JSON.stringify(await cache.inventory(), null, 2));
    else {
      await cache.evict(ids[0], offline);
      console.log(`Evicted ${ids[0]}; saved reviews and session records were not changed.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
