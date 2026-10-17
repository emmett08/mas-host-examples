import type { EvidenceBundle } from "../shared/evidence";
import type { ResolutionReport, ReconciliationObservation } from "../shared/resolution";
import type { RevisionAudit } from "../shared/revision.mjs";

export interface TopologyNode {
  id: string;
  label: string;
  kind: "workflow" | "llm" | "client" | "tool";
  group?: string;
  model?: string;
}

export interface Topology {
  nodes: TopologyNode[];
  edges: { from: string; to: string; kind?: "peer" | "hierarchy" }[];
  mode?: string;
}

export interface Message {
  sequence: number;
  id: string;
  sender: string;
  recipient: string;
  kind: string;
  correlation?: string | null;
  createdAt?: string;
  payload?: unknown;
}

export type Approach = "collected" | "mcp";

export interface Investigation {
  status: "running" | "completed" | "failed";
  runId: string;
  evidence?: EvidenceBundle;
  calls?: { id: string; tool: string; status: string; evidenceIds: string[] }[];
  error?: string;
}

export interface Run {
  approach?: Approach;
  investigation?: Investigation;
  id: string;
  status: string;
  mode: string;
  startedAt: string;
  error?: string | null;
  output?: unknown;
  input?: { incident?: { event?: unknown; source?: string; scenario?: string; context?: string; evidence?: EvidenceBundle } };
  resolution?: ResolutionReport;
  reconciliations?: ReconciliationObservation[];
  revision?: RevisionAudit;
}

export interface Snapshot {
  run: Run;
  observation: { messages: Message[]; observed_at_ms?: number };
  observationAvailable?: boolean;
  investigationObservation?: Snapshot["observation"];
  investigationTopology?: Topology;
}

export interface ArchiveSnapshot extends Snapshot {
  /** Replay frame time; independent host observation timestamps stay unchanged. */
  observedAtMs?: number;
}

export interface RunArchive {
  version: "mas-demo-archive/1";
  capturedAt: string;
  topology: Topology;
  runId: string;
  snapshots: ArchiveSnapshot[];
  comparisons?: RunArchive[];
}
