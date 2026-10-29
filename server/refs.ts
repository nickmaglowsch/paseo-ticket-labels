// Ticket references a workspace is about, read only from places a person or a ticket write put
// them: the workspace title, branch and PR title, the user's own messages, and the agents' Jira
// writes and Wrike fetches. Assistant prose, reasoning and other tool output name every ticket the
// agent happened to read (one workspace mentioned 26 keys), so they are skipped.

const JIRA_KEY = /\bBC-\d+\b/g;
const WRIKE_LINK = /wrike\.com\/open\.htm\?id=(\d+)/g;
const JIRA_WRITES = /Atlassian__(editJiraIssue|transitionJiraIssue|addCommentToJiraIssue|addWorklogToJiraIssue)$/;

export interface Refs {
  jira: Set<string>;
  wrike: Set<string>;
}

export interface WorkspaceMeta {
  title?: string | null;
  name?: string | null;
  gitRuntime?: { currentBranch?: string | null } | null;
  githubRuntime?: { pullRequest?: { title?: string | null; headRefName?: string | null } | null } | null;
}

export function emptyRefs(): Refs {
  return { jira: new Set(), wrike: new Set() };
}

export function addText(refs: Refs, text: unknown): void {
  if (typeof text !== "string") return;
  for (const [key] of text.matchAll(JIRA_KEY)) refs.jira.add(key);
  for (const [, id] of text.matchAll(WRIKE_LINK)) refs.wrike.add(id);
}

export function addWorkspace(refs: Refs, ws: WorkspaceMeta): void {
  addText(refs, ws.title);
  addText(refs, ws.name);
  addText(refs, ws.gitRuntime?.currentBranch);
  addText(refs, ws.githubRuntime?.pullRequest?.title);
  addText(refs, ws.githubRuntime?.pullRequest?.headRefName);
}

// Timeline items arrive as protocol JSON; the tool-call detail is provider-shaped, so read it loosely.
// biome-ignore lint/suspicious/noExplicitAny: provider-shaped tool payloads
export function addTimelineItem(refs: Refs, item: any): void {
  if (item?.type === "user_message") {
    // A handoff from a previous agent arrives as a user message quoting that whole conversation.
    if (!String(item.text ?? "").trimStart().startsWith("<chat-history-summary>")) addText(refs, item.text);
    return;
  }
  if (item?.type !== "tool_call" || item.status === "failed") return;
  const name: string = item.name ?? "";
  const input = item.detail?.input;
  if (name.endsWith("Atlassian__createJiraIssue")) {
    addKey(refs, input?.parent);
    addKey(refs, item.detail?.output?.output?.issues?.nodes?.[0]?.key);
    for (const [, id] of String(input?.description ?? "").matchAll(WRIKE_LINK)) refs.wrike.add(id);
  } else if (JIRA_WRITES.test(name)) {
    addKey(refs, input?.issueIdOrKey);
  } else if (name.endsWith("Wrike__wrike_get_tasks")) {
    for (const id of input?.taskIds ?? []) if (/^\d+$/.test(String(id))) refs.wrike.add(String(id));
  }
}

function addKey(refs: Refs, value: unknown): void {
  if (typeof value === "string" && /^BC-\d+$/.test(value)) refs.jira.add(value);
}
