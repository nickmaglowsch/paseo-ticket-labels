import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Labeler } from "./server/labeler.ts";

// Tickets are closed outside Paseo, so labels of done tickets are swept on a timer too.
const PRUNE_INTERVAL_MS = 6 * 60 * 60_000;

export default function contribute(server: PluginServerContext) {
  const labeler = new Labeler();
  // The only writer: `npm run preview` prints what it would do but never changes labels.
  labeler.enqueue("start", () => labeler.start());
  labeler.enqueue("prune", () => labeler.pruneDone());
  const prune = setInterval(() => labeler.enqueue("prune", () => labeler.pruneDone()), PRUNE_INTERVAL_MS);
  prune.unref();
  server.on("agent.turn_ended", ({ agent }) => {
    const workspaceId = agent.workspaceId;
    if (!workspaceId) return;
    labeler.enqueue(`turn:${agent.id}`, () => labeler.labelTurn(workspaceId, agent.id));
  });
  return () => {
    clearInterval(prune);
    return labeler.close();
  };
}
