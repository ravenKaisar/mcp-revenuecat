import { loadAccountsFromEnv } from "../config/accounts.js";
import { formatConfigError } from "../config/errors.js";

try {
  const accounts = loadAccountsFromEnv();
  console.info(JSON.stringify({ valid: true, accounts: accounts.listPublicAccounts() }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ valid: false, message: formatConfigError(error) }, null, 2));
  process.exit(1);
}
