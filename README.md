# paseo-ticket-labels

A Paseo plugin that labels workspaces with the tickets they work on, so the sidebar's Labels filter
finds every workspace for an Epic or Wrike ticket.

| Label | Color | Comes from |
| --- | --- | --- |
| `BC-1001` | sky | Workspace title, branch or PR title; your messages; stories an agent created, edited, transitioned or commented on |
| `BC-1000` | violet | The Jira parent or "Dependent" link of a key above, one hop, Epics not expanded |
| `W-1000000001` | emerald | Wrike links in your messages or in a created story's description; tasks an agent fetched with `wrike_get_tasks` |

Assistant text, reasoning and other tool output are ignored: they name every ticket the agent read.
Labels are only added, never removed.

## Install

```bash
npm install
paseo plugin install /Volumes/Dev/repos/paseo-ticket-labels
```

Parent lookups need a Jira API token in the keychain. Without it the plugin still labels the keys it
finds directly.

```bash
security add-generic-password -s paseo-ticket-labels-jira -a jira -w 'you@britecore.com:<api-token>'
```

## When it runs

- **Plugin start:** labels every workspace from its title, branch and PR. This loads no agents.
- **After each agent turn:** reads that agent's timeline and labels its workspace.
- **`npm run backfill`:** reads the timeline of every non-archived agent once. Reading a closed
  agent loads it into the daemon, like opening it in the app. Add `-- --dry-run` to only print.

## Caveat

The plugin SDK has no workspace-label call, so `server/labeler.ts` opens its own daemon session
with `~/.paseo/local-credential`, the way the Paseo CLI does. That client API is not a plugin
contract; a Paseo upgrade can break it. Pin `@getpaseo/client` to the daemon's version.
