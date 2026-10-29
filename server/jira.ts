import { execFileSync } from "node:child_process";

const SITE = "https://britecore.atlassian.net";
// Keychain item holding "email:api-token". Read on every uncached lookup, so adding it needs no restart.
const KEYCHAIN_SERVICE = "paseo-ticket-labels-jira";

const TIMEOUT_MS = 15_000;
// Status changes over time, so an answer is reused for an hour. A failure answers "unknown" for
// ten minutes before Jira is asked again.
const ANSWER_TTL_MS = 60 * 60_000;
const FAILURE_TTL_MS = 10 * 60_000;

export interface Issue {
  /** Jira's "done" status category: Done, Closed, Won't Do and the like. */
  done: boolean;
  /** Its parent and the issues on the other end of a "Dependent" link. Empty for an Epic. */
  related: string[];
}

const cache = new Map<string, { expires: number; answer: Promise<Issue | null> }>();
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
 * Looks a ticket up, or answers null when Jira can't be asked (no credential, a failure), so the
 * caller labels what it found and prunes nothing. BriteCore tech-spec stories link to their bug
 * through a "Dependent" link instead of `parent`, so both count as related. One hop only, and an
 * Epic is not expanded, so a label never climbs to an initiative. `fresh` skips the cache (and
 * refreshes it) for decisions that delete something.
 */
export function getIssue(key: string, options: { fresh?: boolean } = {}): Promise<Issue | null> {
  const cached = cache.get(key);
  if (!options.fresh && cached && cached.expires > Date.now()) return cached.answer;
  const auth = readAuth();
  if (!auth) {
    if (!warnedMissingAuth) {
      warnedMissingAuth = true;
      console.warn(
        `[ticket-labels] No Jira credential in keychain item "${KEYCHAIN_SERVICE}"; skipping status and parent lookups`,
      );
    }
    return Promise.resolve(null);
  }
  const entry = { expires: Date.now() + ANSWER_TTL_MS, answer: Promise.resolve<Issue | null>(null) };
  entry.answer = lookup(key, auth).catch((error) => {
    entry.expires = Date.now() + FAILURE_TTL_MS;
    console.error(`[ticket-labels] Jira lookup failed for ${key}: ${error instanceof Error ? error.message : error}`);
    return null;
  });
  cache.set(key, entry);
  return entry.answer;
}

async function lookup(key: string, auth: string): Promise<Issue | null> {
  const response = await fetch(`${SITE}/rest/api/3/issue/${key}?fields=parent,issuelinks,issuetype,status`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { fields } = (await response.json()) as JiraIssue;
  const done = fields.status?.statusCategory?.key === "done";
  if (fields.issuetype?.name === "Epic") return { done, related: [] };
  const related = new Set<string>();
  if (fields.parent?.key) related.add(fields.parent.key);
  for (const link of fields.issuelinks ?? []) {
    if (link.type?.name !== "Dependent") continue;
    const other = link.inwardIssue?.key ?? link.outwardIssue?.key;
    if (other) related.add(other);
  }
  related.delete(key);
  return { done, related: [...related] };
}

interface JiraIssue {
  fields: {
    issuetype?: { name?: string };
    status?: { statusCategory?: { key?: string } };
    parent?: { key?: string };
    issuelinks?: Array<{
      type?: { name?: string };
      inwardIssue?: { key?: string };
      outwardIssue?: { key?: string };
    }>;
  };
}
