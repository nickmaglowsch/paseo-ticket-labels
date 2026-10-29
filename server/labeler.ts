import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHostClient } from "@getpaseo/client/node";
import { getIssue } from "./jira.ts";
import { addTimelineItem, addWorkspace, emptyRefs, type Refs } from "./refs.ts";

type DaemonClient = ReturnType<typeof createHostClient>;
type Workspace = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>["entries"][number];
type LabelColor = "sky" | "violet" | "emerald";

const STORY: LabelColor = "sky";
const PARENT: LabelColor = "violet";
const WRIKE: LabelColor = "emerald";
const PAGE = 200;
// ponytail: a turn rescans only the newest items. A turn longer than this can miss its earliest
// tool calls; `npm run backfill` reads everything.
const TURN_TAIL = 500;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 30_000;

/**
 * The plugin SDK has no workspace-label call, so this opens its own daemon session the way the
 * CLI does: the daemon's local credential over its listen address. That client API is not a
 * plugin contract and can break on a Paseo upgrade.
 */
export class Labeler {
  private readonly home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  // Labels this plugin created. Only these are ever deleted, so a label you made yourself survives.
  private readonly ownedPath = join(this.home, "ticket-labels-owned.json");
  // Present once the full transcript backfill has run. Delete it and reload the plugin to rerun.
  private readonly backfilledPath = join(this.home, "ticket-labels-backfilled");
  private readonly dryRun: boolean;
  private client: DaemonClient | null = null;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<string>();
  private readonly applied = new Set<string>();

  constructor(options: { dryRun?: boolean } = {}) {
    this.dryRun = options.dryRun ?? false;
  }

  /**
   * Runs jobs one at a time. A key that is already waiting is not queued twice, so a burst of turn
   * ends costs one scan. A failed job (the daemon reconnecting, say) retries a few times.
   */
  enqueue(key: string, task: () => Promise<void>, attempt = 1): void {
    if (this.stopped || this.pending.has(key)) return;
    this.pending.add(key);
    this.queue = this.queue.then(async () => {
      this.pending.delete(key);
      if (this.stopped) return;
      try {
        await task();
      } catch (error) {
        console.error(`[ticket-labels] ${key} failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, error);
        if (attempt < MAX_ATTEMPTS) {
          setTimeout(() => this.enqueue(key, task, attempt + 1), RETRY_MS).unref();
        }
      }
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    await client?.close();
  }

  /**
   * Labels every workspace from its title, branch and PR. The first start also reads each
   * non-archived agent's whole timeline. Reading a closed agent's timeline loads it back into the
   * daemon, like opening it in the app, so later starts skip it.
   */
  async start(): Promise<void> {
    // ponytail: the marker is written even if some agents were skipped (logged). Retrying them on
    // every start would re-read agents that can never load, such as a logged-out provider's.
    const transcripts = !existsSync(this.backfilledPath);
    await this.backfill({ transcripts });
    if (transcripts && !this.dryRun && !this.stopped) writeFileSync(this.backfilledPath, `${new Date().toISOString()}\n`);
  }

  async backfill(options: { transcripts: boolean }): Promise<void> {
    const client = await this.connect();
    const workspaces = await this.listWorkspaces(client);
    const agentsByWorkspace = new Map<string, string[]>();
    let cursor: string | undefined;
    while (options.transcripts) {
      const page = await client.fetchAgents({ page: { limit: PAGE, ...(cursor ? { cursor } : {}) } });
      for (const { agent } of page.entries) {
        if (!agent.workspaceId || agent.archivedAt) continue;
        const ids = agentsByWorkspace.get(agent.workspaceId) ?? [];
        ids.push(agent.id);
        agentsByWorkspace.set(agent.workspaceId, ids);
      }
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      if (!cursor) break;
    }
    for (const workspace of workspaces) {
      await this.labelWorkspace(client, workspace, agentsByWorkspace.get(workspace.id) ?? [], true);
    }
    console.log(`[ticket-labels] backfill scanned ${workspaces.length} workspaces`);
  }

  /**
   * Deletes every Jira label this plugin created whose ticket is now done, which takes it off every
   * workspace.
   */
  async pruneDone(): Promise<void> {
    const client = await this.connect();
    const owned = this.readOwned();
    const { labels } = await client.listWorkspaceLabels();
    for (const { name } of labels) {
      if (this.stopped) return;
      if (!owned.has(name) || !/^BC-\d+$/.test(name)) continue;
      if (!(await getIssue(name, { fresh: true }))?.done) continue;
      console.log(`[ticket-labels] ${name} is done; deleting its label`);
      if (this.dryRun) continue;
      await client.deleteWorkspaceLabel({ name });
      this.updateOwned((names) => names.delete(name));
      for (const key of this.applied) if (key.endsWith(`\0${name}`)) this.applied.delete(key);
    }
  }

  /** Labels a workspace from its own fields and the newest part of one agent's timeline. */
  async labelTurn(workspaceId: string, agentId: string): Promise<void> {
    const client = await this.connect();
    // ponytail: lists every workspace to find one; the daemon has no exact-id filter.
    const workspace = (await this.listWorkspaces(client)).find((entry) => entry.id === workspaceId);
    if (workspace) await this.labelWorkspace(client, workspace, [agentId], false);
  }

  private async labelWorkspace(
    client: DaemonClient,
    workspace: Workspace,
    agentIds: readonly string[],
    fullHistory: boolean,
  ): Promise<void> {
    const refs = emptyRefs();
    addWorkspace(refs, workspace);
    for (const agentId of agentIds) {
      try {
        await this.addAgent(client, refs, agentId, fullHistory);
      } catch (error) {
        // A turn's agent was just running, so its failure is transient: let the queue retry it.
        // Backfill meets agents that cannot load at all (a logged-out provider) and moves on.
        if (!fullHistory) throw error;
        console.warn(`[ticket-labels] skipped agent ${agentId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    await this.apply(client, workspace.id, workspace.title ?? workspace.name ?? workspace.id, refs);
  }

  private async addAgent(client: DaemonClient, refs: Refs, agentId: string, fullHistory: boolean): Promise<void> {
    const limit = fullHistory ? 1000 : TURN_TAIL;
    let page = await client.fetchAgentTimeline(agentId, { direction: "tail", limit });
    for (;;) {
      for (const entry of page.entries) addTimelineItem(refs, entry.item);
      if (!fullHistory || !page.hasOlder || !page.startCursor || this.stopped) return;
      page = await client.fetchAgentTimeline(agentId, { direction: "before", cursor: page.startCursor, limit });
    }
  }

  private async listWorkspaces(client: DaemonClient): Promise<Workspace[]> {
    const workspaces: Workspace[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await client.fetchWorkspaces({ page: { limit: PAGE, ...(cursor ? { cursor } : {}) } });
      workspaces.push(...page.entries);
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      if (!cursor) return workspaces;
    }
  }

  private async apply(client: DaemonClient, workspaceId: string, title: string, refs: Refs): Promise<void> {
    // Done tickets get no label. Without Jira (no credential, a failure) every key counts as open.
    const labels = new Map<string, LabelColor>();
    const parents = new Set<string>();
    for (const key of refs.jira) {
      if (this.stopped) return;
      const issue = await getIssue(key);
      if (!issue?.done) labels.set(key, STORY);
      for (const parent of issue?.related ?? []) parents.add(parent);
    }
    for (const parent of parents) {
      if (this.stopped) return;
      if (!labels.has(parent) && !(await getIssue(parent))?.done) labels.set(parent, PARENT);
    }
    for (const id of refs.wrike) labels.set(`W-${id}`, WRIKE);

    const fresh = [...labels].filter(([name]) => !this.applied.has(`${workspaceId}\0${name}`));
    if (fresh.length === 0) return;
    console.log(`[ticket-labels] ${title}: ${fresh.map(([name]) => name).join(", ")}`);
    if (this.dryRun || this.stopped) return;
    // ponytail: a label you create by hand in the moment between this read and the assignment below
    // would be recorded as the plugin's. Closing that needs an atomic create-if-absent in the daemon.
    const existing = new Set((await client.listWorkspaceLabels()).labels.map((label) => label.name));
    for (const [name, color] of fresh) {
      await client.setWorkspaceLabel({ workspaceId, label: { name, color }, assigned: true });
      if (!existing.has(name)) this.updateOwned((names) => names.add(name));
      this.applied.add(`${workspaceId}\0${name}`);
    }
  }

  private readOwned(): Set<string> {
    try {
      return new Set(JSON.parse(readFileSync(this.ownedPath, "utf8")) as string[]);
    } catch {
      return new Set();
    }
  }

  // Only the running plugin writes labels, and its jobs run one at a time, so this needs no lock.
  private updateOwned(change: (names: Set<string>) => void): void {
    const names = this.readOwned();
    change(names);
    const tmp = `${this.ownedPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify([...names].sort(), null, 1)}\n`);
    renameSync(tmp, this.ownedPath);
  }

  private async connect(): Promise<DaemonClient> {
    if (this.stopped) throw new Error("labeler stopped");
    if (this.client) return this.client;
    const { listen } = JSON.parse(readFileSync(join(this.home, "paseo.pid"), "utf8")) as { listen: string };
    const client = createHostClient(listen, {
      clientId: "paseo-ticket-labels",
      clientType: "cli",
      appVersion: "0.13.0",
      localCredential: () => readFileSync(join(this.home, "local-credential"), "utf8").trim(),
      reconnect: { enabled: true },
    });
    // Owned before the handshake finishes, so close() during startup still tears it down.
    this.client = client;
    try {
      await client.connect();
    } catch (error) {
      if (this.client === client) this.client = null;
      await client.close();
      throw error;
    }
    return client;
  }
}
