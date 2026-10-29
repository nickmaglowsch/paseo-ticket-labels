import { Labeler } from "../server/labeler.ts";

const labeler = new Labeler({ dryRun: process.argv.includes("--dry-run") });
await labeler.backfill({ transcripts: true });
await labeler.close();
