import type { ApprovalGrantRecord, SessionRecord } from "@openharbor/schemas";
import type { LocalHarborStore, TestRunRecord } from "./local-store.js";
import type { SessionManager } from "./session-manager.js";

export interface SessionOverview {
  session: SessionRecord;
  draft: {
    changeCount: number;
    paths: string[];
    files: Array<{
      path: string;
      hunkCount: number;
      addedLines: number;
      removedLines: number;
    }>;
  };
  tests: {
    recentRuns: TestRunRecord[];
  };
  approvals: {
    active: ApprovalGrantRecord[];
  };
  publish: {
    changeCount: number;
    paths: string[];
  };
}

export async function getSessionOverview(
  sessions: SessionManager,
  store: LocalHarborStore,
  sessionId: string,
): Promise<SessionOverview> {
  const bundle = await sessions.getBundle(sessionId);
  const changes = await bundle.overlay.listChangesResolved();
  const diffs = await bundle.overlay.diffAll();
  const runs = await store.listTestRuns(sessionId);
  const approvals = sessions.listApprovalGrants(sessionId, { includeInactive: false });

  return {
    session: bundle.session,
    draft: {
      changeCount: changes.length,
      paths: changes.map((change) => change.path),
      files: diffs.map((file) => ({
        path: file.path,
        hunkCount: file.hunks.length,
        addedLines: countPrefixedLines(file.hunks, "+"),
        removedLines: countPrefixedLines(file.hunks, "-"),
      })),
    },
    tests: {
      recentRuns: [...runs]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 10),
    },
    approvals: {
      active: approvals,
    },
    publish: {
      changeCount: changes.length,
      paths: changes.map((change) => change.path),
    },
  };
}

function countPrefixedLines(
  hunks: Array<{ lines: string[] }>,
  prefix: "+" | "-",
): number {
  let total = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)) {
        total += 1;
      }
    }
  }
  return total;
}
