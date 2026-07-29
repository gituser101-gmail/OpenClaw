import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionTranscriptActiveStats } from "./session-accessor.sqlite-active-events.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

type ActiveTranscriptDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_active_events" | "transcript_event_identities" | "transcript_events"
>;

type ContextBoundary = {
  activePosition: number;
  firstKeptEntryId?: string;
};

function findLatestContextBoundary(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  sessionId: string,
): ContextBoundary | undefined {
  const db = getNodeSqliteKysely<ActiveTranscriptDatabase>(database.db);
  const boundary = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select(["active.active_position", "event.event_json"])
      .where("active.session_id", "=", sessionId)
      .where("active.message_position", "is", null)
      .orderBy("active.active_position", "desc"),
  ).rows.find((row) => {
    try {
      const type = (JSON.parse(row.event_json) as { type?: unknown }).type;
      return type === "compaction" || type === "reset";
    } catch {
      return false;
    }
  });
  if (!boundary) {
    return undefined;
  }
  let firstKeptEntryId: string | undefined;
  try {
    const parsed = JSON.parse(boundary.event_json) as { firstKeptEntryId?: unknown };
    if (typeof parsed.firstKeptEntryId === "string") {
      firstKeptEntryId = parsed.firstKeptEntryId;
    }
  } catch {
    // Keep the boundary itself as the conservative context start.
  }
  return {
    activePosition: boundary.active_position,
    firstKeptEntryId,
  };
}

/**
 * Returns serialized bytes in the context-replay window, not total active-path history.
 * SQLite retains events before compaction for audit and UI history, so those bytes must
 * not keep retriggering the model-context guard after compaction succeeds.
 */
export function readSessionTranscriptContextByteSize(scope: SessionTranscriptReadScope): number {
  // Validate that the active projection is current through the canonical accessor.
  readSessionTranscriptActiveStats(scope);

  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getNodeSqliteKysely<ActiveTranscriptDatabase>(database.db);
      const boundary = findLatestContextBoundary(database, resolved.sessionId);
      let startPosition = boundary?.activePosition ?? 0;
      if (boundary?.firstKeptEntryId) {
        const kept = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_event_identities as identity")
            .innerJoin("session_transcript_active_events as active", (join) =>
              join
                .onRef("active.session_id", "=", "identity.session_id")
                .onRef("active.event_seq", "=", "identity.seq"),
            )
            .select("active.active_position")
            .where("identity.session_id", "=", resolved.sessionId)
            .where("identity.event_id", "=", boundary.firstKeptEntryId),
        );
        if (kept && kept.active_position < boundary.activePosition) {
          startPosition = kept.active_position;
        }
      }
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_transcript_active_events as active")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "active.session_id")
              .onRef("event.seq", "=", "active.event_seq"),
          )
          .select(
            /* kysely-allow-raw: exact replay-window byte count without materializing events. */
            sql<number>`COALESCE(SUM(LENGTH(CAST(event.event_json AS BLOB)) + 1), 0)`.as("bytes"),
          )
          .where("active.session_id", "=", resolved.sessionId)
          .where("active.active_position", ">=", startPosition),
      );
      const bytes = row?.bytes ?? 0;
      return Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0;
    },
    {
      databaseLabel: database.path,
      operationLabel: "sessions.context-bytes.read",
    },
  );
}
