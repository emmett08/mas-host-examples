export interface TopologyNode {
  id: string;
  label: string;
  kind: "workflow" | "llm" | "client";
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

export interface Run {
  id: string;
  status: string;
  mode: string;
  startedAt: string;
  error?: string | null;
  output?: unknown;
}

export interface Snapshot {
  run: Run;
  observation: { messages: Message[]; observed_at_ms?: number };
  observationAvailable?: boolean;
}

export interface ArchiveSnapshot extends Snapshot {
  observation: Snapshot["observation"] & { observed_at_ms: number };
}

export interface RunArchive {
  version: "mas-demo-archive/1";
  capturedAt: string;
  topology: Topology;
  runId: string;
  snapshots: ArchiveSnapshot[];
}
