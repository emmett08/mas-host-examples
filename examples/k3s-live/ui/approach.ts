import type { Approach, Run, RunArchive, Snapshot } from "./types";

export const approachOf = (run?: Pick<Run, "approach">): Approach => run?.approach ?? "collected";
export const approachRuns = (runs: Run[], approach: Approach) => runs.filter(run => approachOf(run) === approach);
export const archiveRuns = (archive?: RunArchive): RunArchive[] => archive ? [archive, ...(archive.comparisons ?? [])] : [];

/** Link a comparison to a separately recorded outcome only for the same Pod identity. */
export function recordedRecoverySource(archives: RunArchive[], comparison?: Run): Run | undefined {
  if (approachOf(comparison) !== "mcp") return undefined;
  const subject = comparison?.investigation?.evidence?.subject;
  if (!subject?.uid) return undefined;
  return archives.map(archive => archive.snapshots.at(-1)?.run).find(run => {
    const original = run?.input?.incident?.evidence?.subject;
    return run && approachOf(run) === "collected" && run.resolution && original?.uid === subject.uid &&
      original.namespace === subject.namespace && original.name === subject.name;
  });
}

/** Keep the user's selection in each approach while history refreshes. */
export function selectApproachRun(runs: Run[], approach: Approach, remembered = ""): string {
  const choices = approachRuns(runs, approach);
  return choices.find(run => run.id === remembered)?.id ?? choices[0]?.id ?? "";
}

export type Phase = "investigation" | "assessment";
export const phaseMessages = (snapshot: Snapshot, phase: Phase) =>
  phase === "investigation" ? snapshot.investigationObservation?.messages ?? [] : snapshot.observation.messages;
