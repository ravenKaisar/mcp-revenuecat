import { readFileSync } from "node:fs";
import { z } from "zod";

const PUBLIC_SDK_KEY_PREFIX = /^(appl|goog|amzn|strp|rcb|test)_/;

export const revenueCatAccountSchema = z.object({
  id: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).refine(
    (key) => !PUBLIC_SDK_KEY_PREFIX.test(key),
    "must be a RevenueCat API v2 secret key (sk_...), not a public SDK key"
  )
}).strict();

const accountsSchema = z.array(revenueCatAccountSchema).min(1);

export type RevenueCatAccount = z.infer<typeof revenueCatAccountSchema>;

export type PublicRevenueCatAccount = Pick<RevenueCatAccount, "id" | "projectId">;

export class AccountConfig {
  private readonly accountsById = new Map<string, RevenueCatAccount>();
  private readonly accountsByProjectId = new Map<string, RevenueCatAccount>();

  constructor(accounts: RevenueCatAccount[]) {
    for (const account of accounts) {
      if (this.accountsById.has(account.id)) {
        throw new Error(`Duplicate RevenueCat account id: ${account.id}`);
      }
      const existing = this.accountsByProjectId.get(account.projectId);
      if (existing) {
        throw new Error(
          `RevenueCat accounts "${existing.id}" and "${account.id}" use the same projectId "${account.projectId}"`
        );
      }
      this.accountsById.set(account.id, account);
      this.accountsByProjectId.set(account.projectId, account);
    }
  }

  get size(): number {
    return this.accountsById.size;
  }

  all(): RevenueCatAccount[] {
    return [...this.accountsById.values()];
  }

  listPublicAccounts(): PublicRevenueCatAccount[] {
    return this.all().map(({ id, projectId }) => ({ id, projectId }));
  }

  findAccount(idOrProjectId: string): RevenueCatAccount | undefined {
    return this.accountsById.get(idOrProjectId) ?? this.accountsByProjectId.get(idOrProjectId);
  }

  findByProjectId(projectId: string): RevenueCatAccount | undefined {
    return this.accountsByProjectId.get(projectId);
  }
}

export function loadAccountsFromEnv(env: NodeJS.ProcessEnv = process.env): AccountConfig {
  const file = env.REVENUECAT_ACCOUNTS_FILE?.trim();
  if (!file) {
    throw new Error("Set REVENUECAT_ACCOUNTS_FILE to the mounted revenuecat_accounts.json path");
  }
  return parseAccountsConfig(readFileSync(file, "utf8"));
}

export function parseAccountsConfig(raw: string): AccountConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RevenueCat account configuration must be valid JSON");
  }
  return new AccountConfig(accountsSchema.parse(parsed));
}
