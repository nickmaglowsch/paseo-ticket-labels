import { Labeler } from "../server/labeler.ts";

// Prints the labels a full backfill would add and the done labels it would delete. Writes nothing:
// the running plugin is the only writer.
const labeler = new Labeler({ dryRun: true });
await labeler.backfill({ transcripts: true });
await labeler.pruneDone();
await labeler.close();
