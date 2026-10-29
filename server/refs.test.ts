import assert from "node:assert/strict";
import { test } from "node:test";
import { addTimelineItem, addWorkspace, emptyRefs } from "./refs.ts";

test("reads keys from the workspace title, branch and PR", () => {
  const refs = emptyRefs();
  addWorkspace(refs, {
    title: "Fix BC-1001 quote dates",
    gitRuntime: { currentBranch: "BC-1002-impl" },
    githubRuntime: { pullRequest: { title: "BC-1003 | Tech spec", headRefName: "x" } },
  });
  assert.deepEqual([...refs.jira].sort(), ["BC-1001", "BC-1002", "BC-1003"]);
});

test("reads keys and Wrike links from user messages only", () => {
  const refs = emptyRefs();
  addTimelineItem(refs, { type: "user_message", text: "do BC-1 see https://www.wrike.com/open.htm?id=1000000001" });
  addTimelineItem(refs, { type: "assistant_message", text: "BC-1004 introduced this" });
  addTimelineItem(refs, { type: "user_message", text: "<chat-history-summary>\nwe touched BC-1005 and BC-21…" });
  addTimelineItem(refs, { type: "tool_call", name: "Bash", status: "completed", detail: { output: "BC-99" } });
  assert.deepEqual([...refs.jira], ["BC-1"]);
  assert.deepEqual([...refs.wrike], ["1000000001"]);
});

test("reads created stories, their parent and Wrike link, but not keys in the description", () => {
  const refs = emptyRefs();
  addTimelineItem(refs, {
    type: "tool_call",
    name: "mcp__claude_ai_Atlassian__createJiraIssue",
    status: "completed",
    detail: {
      input: { parent: "BC-1010", description: "Wrike: https://www.wrike.com/open.htm?id=42. BC-1011 covers it" },
      output: { output: { issues: { nodes: [{ key: "BC-1012" }] } } },
    },
  });
  assert.deepEqual([...refs.jira].sort(), ["BC-1010", "BC-1012"]);
  assert.deepEqual([...refs.wrike], ["42"]);
});

test("reads Jira writes and Wrike fetches, skips failed calls and reads", () => {
  const refs = emptyRefs();
  const call = (name: string, input: object, status = "completed") =>
    addTimelineItem(refs, { type: "tool_call", name, status, detail: { input } });
  call("mcp__claude_ai_Atlassian__transitionJiraIssue", { issueIdOrKey: "BC-5" });
  call("mcp__claude_ai_Atlassian__addCommentToJiraIssue", { issueIdOrKey: "BC-6" }, "failed");
  call("mcp__claude_ai_Atlassian__getJiraIssue", { issueIdOrKey: "BC-7" });
  call("mcp__claude_ai_Wrike__wrike_get_tasks", { taskIds: ["123", "MAAAAABlM4pq"] });
  assert.deepEqual([...refs.jira], ["BC-5"]);
  assert.deepEqual([...refs.wrike], ["123"]);
});
