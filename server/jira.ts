import { execFileSync } from "node:child_process";

const SITE = "https://britecore.atlassian.net";
// Keychain item holding "email:api-token". Read on every uncached lookup, so adding it needs no restart.
const KEYCHAIN_SERVICE = "paseo-ticket-labels-jira";

const TIMEOUT_MS = 15_000;
// A failed lookup answers "no related keys" for this long before Jira is asked again.
const FAILURE_COOLDOWN_MS = 10 * 60_000;

const cache = new Map<string, Promise<string[]>>();
let warnedMissingAuth = false;

function readAuth(): string | null {
  try {
    const secret = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return secret.includes(":") ? Buffer.from(secret).toString("base64") : null;
  } catch {
    return null;
  }
}

/**
 * The tickets a story hangs off: its parent, and the issues on the other end of a "Dependent"
 * link (BriteCore tech-spec stories link to their bug that way instead of through `parent`).
 * One hop only, and an Epic is not expanded, so a label never climbs to an initiative.
 */
export function relatedKeys(key: string): Promise<string[]> {
  const cached = cache.get(key);
  if (cached) return cached;
  const auth = readAuth();
  if (!auth) {
    if (!warnedMissingAuth) {
      warnedMissingAuth = true;
      console.warn(`[ticket-labels] No Jira credential in keychain item "${KEYCHAIN_SERVICE}"; skipping parent lookups`);
    }
    return Promise.resolve([]);
  }
  const pending = lookup(key, auth).catch((error) => {
    setTimeout(() => cache.delete(key), FAILURE_COOLDOWN_MS).unref();
    console.error(`[ticket-labels] Jira lookup failed for ${key}: ${error instanceof Error ? error.message : error}`);
    return [];
  });
  cache.set(key, pending);
  return pending;
}

async function lookup(key: string, auth: string): Promise<string[]> {
  const response = await fetch(`${SITE}/rest/api/3/issue/${key}?fields=parent,issuelinks,issuetype`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { fields } = (await response.json()) as JiraIssue;
  if (fields.issuetype?.name === "Epic") return [];
  const related = new Set<string>();
  if (fields.parent?.key) related.add(fields.parent.key);
  for (const link of fields.issuelinks ?? []) {
    if (link.type?.name !== "Dependent") continue;
    const other = link.inwardIssue?.key ?? link.outwardIssue?.key;
    if (other) related.add(other);
  }
  related.delete(key);
  return [...related];
}

interface JiraIssue {
  fields: {
    issuetype?: { name?: string };
    parent?: { key?: string };
    issuelinks?: Array<{
      type?: { name?: string };
      inwardIssue?: { key?: string };
      outwardIssue?: { key?: string };
    }>;
  };
}
