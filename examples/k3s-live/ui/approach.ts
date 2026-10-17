import type { Approach, Run, RunArchive, Snapshot } from "./types";

export const approachOf = (run?: Pick<Run, "approach">): Approach => run?.approach ?? "collected";
export const approachRuns = (runs: Run[], approach: Approach) => runs.filter(run => approachOf(run) === approach);
export const archiveRuns = (archive?: RunArchive): RunArchive[] => archive ? [archive, ...(archive.comparisons ?? [])] : [];

/** Keep the user's selection in each approach while history refreshes. */
export function selectApproachRun(runs: Run[], approach: Approach, remembered = ""): string {
  const choices = approachRuns(runs, approach);
  return choices.find(run => run.id === remembered)?.id ?? choices[0]?.id ?? "";
}

export type Phase = "investigation" | "assessment";
export const phaseMessages = (snapshot: Snapshot, phase: Phase) =>
  phase === "investigation" ? snapshot.investigationObservation?.messages ?? [] : snapshot.observation.messages;
