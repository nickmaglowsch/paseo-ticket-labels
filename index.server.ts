import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Labeler } from "./server/labeler.ts";

export default function contribute(server: PluginServerContext) {
  const labeler = new Labeler();
  // Titles, branches and PRs only: cheap enough for every start. `npm run backfill` reads transcripts.
  labeler.enqueue("start", () => labeler.backfill({ transcripts: false }));
  server.on("agent.turn_ended", ({ agent }) => {
    const workspaceId = agent.workspaceId;
    if (!workspaceId) return;
    labeler.enqueue(`turn:${agent.id}`, () => labeler.labelTurn(workspaceId, agent.id));
  });
  return () => labeler.close();
}
