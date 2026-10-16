import type { Message, Topology, TopologyNode } from "./types";

export type MessageTone = "request" | "result" | "error" | "other";
export type PositionedNode = TopologyNode & { x: number; y: number };

export function messageTone(kind: string): MessageTone {
  const value = kind.toLowerCase();
  if (/error|fail|reject/.test(value)) return "error";
  if (/result|response|reply|complete/.test(value)) return "result";
  if (/request|task|invoke/.test(value)) return "request";
  return "other";
}

export function deduplicateMessages(messages: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

/** MAS reply_to is normalised to correlation by the observation server. */
export function isRequestComplete(
  request: Message,
  messages: Message[],
): boolean {
  return messages.some(
    (candidate) =>
      candidate.sequence > request.sequence &&
      (messageTone(candidate.kind) === "result" ||
        messageTone(candidate.kind) === "error") &&
      candidate.sender === request.recipient &&
      candidate.recipient === request.sender &&
      candidate.correlation === request.id,
  );
}

export function nodeGroup(node: TopologyNode): string {
  if (node.group) return node.group;
  if (node.kind === "client") return "ingress";
  return node.kind === "workflow" ? "coordination" : "specialists";
}

export function orderedGroups(topology: Topology): string[] {
  const present = [...new Set(topology.nodes.map(nodeGroup))];
  const order = ["ingress", "coordination", "specialists", "decision"];
  return present.sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
  });
}

export function layoutTopology(
  topology: Topology,
  width: number,
  height: number,
): PositionedNode[] {
  const groups = orderedGroups(topology);
  const vertical = width < 680;
  return topology.nodes.map((node) => {
    const group = nodeGroup(node);
    const peers = topology.nodes.filter((item) => nodeGroup(item) === group);
    const position = peers.findIndex((item) => item.id === node.id);
    const groupPosition = groups.indexOf(group);
    const along =
      peers.length === 1
        ? 0.5
        : vertical
          ? (position + 0.5) / peers.length
          : (position + 1) / (peers.length + 1);
    const across =
      groups.length === 1 ? 0.5 : (groupPosition + 0.5) / groups.length;
    return {
      ...node,
      x: vertical ? 48 + along * (width - 96) : 32 + across * (width - 64),
      y: vertical ? 36 + across * (height - 72) : 40 + along * (height - 80),
    };
  });
}

export function formatDuration(startedAt: string, now = Date.now()): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "—";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
