<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  isRequestComplete,
  layoutTopology,
  messageTone,
  nodeGroup,
  orderedGroups,
} from "../topology";
import type { PositionedNode } from "../topology";
import type { Message, Topology } from "../types";

const props = defineProps<{
  topology: Topology;
  investigation?: boolean;
  messages: Message[];
  arrivals: Message[];
  selectedMessage?: Message | null;
  selectedNode?: string | null;
}>();
const emit = defineEmits<{ selectNode: [id: string] }>();
const board = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const reducedMotion = ref(false);
const width = ref(900);
const height = ref(470);
const positions = computed(() =>
  layoutTopology(props.topology, width.value, height.value),
);
const description = computed(() =>
  props.topology.nodes
    .map(
      (node) =>
        `${node.label}: ${node.kind === "llm" ? "LLM agent" : node.kind === "workflow" ? "workflow" : node.kind === "tool" ? props.investigation ? "MCP tool adapter" : "deterministic evaluator" : "event source"}`,
    )
    .join(". "),
);

type Pulse = { message: Message; started: number };
type Point = { x: number; y: number };
let pulses: Pulse[] = [];
let frame = 0;
let observer: ResizeObserver | undefined;
let media: MediaQueryList | undefined;
let disposed = false;
const colours = {
  request: "#4bd3df",
  result: "#aa9bff",
  error: "#fb8494",
  other: "#b4bfce",
};
const groupNames: Record<string, string> = {
  ingress: "EVENT SOURCE",
  coordination: "WORKFLOW SUPERVISION",
  specialists: "LLM SPECIALISTS",
  decision: "CANDIDATE AND CHECKS",
};

function route(
  from: PositionedNode,
  to: PositionedNode,
): [Point, Point, Point, Point] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const radius = 30;
  const start = {
    x: from.x + (dx / distance) * radius,
    y: from.y + (dy / distance) * radius,
  };
  const end = {
    x: to.x - (dx / distance) * radius,
    y: to.y - (dy / distance) * radius,
  };
  if (Math.abs(dx) < 15) {
    const bend = dy > 0 ? 44 : -44;
    return [
      start,
      { x: start.x + bend, y: start.y + dy * 0.28 },
      { x: end.x + bend, y: end.y - dy * 0.28 },
      end,
    ];
  }
  if (Math.abs(dy) < 15 && nodeGroup(from) === nodeGroup(to)) {
    const bend = dx > 0 ? -42 : 42;
    return [
      start,
      { x: start.x + dx * 0.3, y: start.y + bend },
      { x: end.x - dx * 0.3, y: end.y + bend },
      end,
    ];
  }
  return [
    start,
    { x: start.x + dx * 0.38, y: start.y },
    { x: end.x - dx * 0.38, y: end.y },
    end,
  ];
}

function at(path: Point[], t: number): Point {
  const n = 1 - t;
  return {
    x:
      n ** 3 * path[0].x +
      3 * n ** 2 * t * path[1].x +
      3 * n * t ** 2 * path[2].x +
      t ** 3 * path[3].x,
    y:
      n ** 3 * path[0].y +
      3 * n ** 2 * t * path[1].y +
      3 * n * t ** 2 * path[2].y +
      t ** 3 * path[3].y,
  };
}

function strokePath(
  ctx: CanvasRenderingContext2D,
  path: Point[],
  colour: string,
  lineWidth = 1,
  dash: number[] = [],
) {
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  ctx.bezierCurveTo(
    path[1].x,
    path[1].y,
    path[2].x,
    path[2].y,
    path[3].x,
    path[3].y,
  );
  ctx.strokeStyle = colour;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
}

function circle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  fill: string,
) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
) {
  let fitting = text;
  while (ctx.measureText(fitting).width > maxWidth && fitting.length > 3)
    fitting = `${fitting.slice(0, -2)}…`;
  ctx.fillText(fitting, x, y);
}

function draw(now = performance.now()) {
  frame = 0;
  const element = canvas.value;
  const ctx = element?.getContext("2d");
  if (!ctx || !element || disposed) return;
  // A newly mounted or resized canvas can paint before ResizeObserver runs.
  // Size both its backing bitmap and node layout from the current CSS box.
  const bounds = element.getBoundingClientRect();
  const w = Math.max(1, bounds.width);
  const h = Math.max(1, bounds.height);
  width.value = w;
  height.value = h;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (
    element.width !== Math.round(w * dpr) ||
    element.height !== Math.round(h * dpr)
  ) {
    element.width = Math.round(w * dpr);
    element.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = "middle";
  const groups = orderedGroups(props.topology);
  const vertical = w < 680;
  groups.forEach((group, index) => {
    const across = groups.length === 1 ? 0.5 : (index + 0.5) / groups.length;
    ctx.font = '600 9px "IBM Plex Mono", monospace';
    ctx.fillStyle = "#73849d";
    if (vertical) {
      const y = 36 + across * (h - 72);
      ctx.textAlign = "left";
      ctx.fillText(
        props.investigation && group === "coordination" ? "LLM INVESTIGATION" : groupNames[group] ?? group.toUpperCase().replaceAll("_", " "),
        18,
        y - 51,
      );
    } else {
      ctx.textAlign = "center";
      label(
        ctx,
        props.investigation && group === "coordination" ? "LLM INVESTIGATION" : groupNames[group] ?? group.toUpperCase().replaceAll("_", " "),
        32 + across * (w - 64),
        25,
        (w - 64) / groups.length - 8,
      );
    }
  });
  const byId = new Map(positions.value.map((node) => [node.id, node]));
  const drawn = new Set<string>();
  props.topology.edges.forEach((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return;
    const key = [edge.from, edge.to].sort().join(":");
    if (drawn.has(key)) return;
    drawn.add(key);
    const lateral = edge.kind === "peer";
    strokePath(
      ctx,
      route(from, to),
      lateral ? "#3c405a" : "#29374c",
      1.2,
      lateral ? [4, 5] : [],
    );
  });

  props.messages
    .filter(
      (message) =>
        messageTone(message.kind) === "request" &&
        !isRequestComplete(message, props.messages),
    )
    .forEach((message) => {
      const from = byId.get(message.sender);
      const to = byId.get(message.recipient);
      if (from && to) strokePath(ctx, route(from, to), "#285766", 2, [3, 5]);
    });

  if (props.selectedMessage) {
    const from = byId.get(props.selectedMessage.sender);
    const to = byId.get(props.selectedMessage.recipient);
    if (from && to)
      strokePath(
        ctx,
        route(from, to),
        colours[messageTone(props.selectedMessage.kind)],
        2.5,
      );
  }

  pulses = pulses.filter((pulse) => now - pulse.started < 1800);
  for (const pulse of pulses) {
    const from = byId.get(pulse.message.sender);
    const to = byId.get(pulse.message.recipient);
    if (!from || !to) continue;
    const path = route(from, to);
    const progress = Math.min(1, (now - pulse.started) / 1800);
    const colour = colours[messageTone(pulse.message.kind)];
    strokePath(ctx, path, `${colour}45`, 1.5);
    for (let trail = 10; trail >= 0; trail--) {
      const point = at(path, Math.max(0, progress - trail * 0.013));
      ctx.globalAlpha = (1 - trail / 11) * 0.8;
      circle(ctx, point.x, point.y, trail === 0 ? 5 : 2.5, colour);
    }
    ctx.globalAlpha = 1;
    const point = at(path, progress);
    circle(ctx, point.x, point.y, 2, "#eefaff");
  }

  for (const node of positions.value) {
    const peersInGroup = positions.value.filter(
      (item) => nodeGroup(item) === nodeGroup(node),
    ).length;
    const labelWidth = vertical
      ? Math.max(40, (w - 96) / peersInGroup - 12)
      : (w - 64) / Math.max(groups.length, 1) - 12;
    const received = props.messages.filter(
      (message) => message.recipient === node.id,
    );
    const pending = received.some(
      (message) =>
        messageTone(message.kind) === "request" &&
        !isRequestComplete(message, props.messages),
    );
    const hasError = received.some(
      (message) => messageTone(message.kind) === "error",
    );
    const selected = props.selectedNode === node.id;
    const colour =
      node.kind === "llm"
        ? "#aa9bff"
        : node.kind === "client"
          ? "#9cacc0"
          : "#4bd3df";
    if (pending || selected) {
      circle(ctx, node.x, node.y, 38, `${colour}0c`);
      ctx.beginPath();
      ctx.arc(node.x, node.y, 34, 0, Math.PI * 2);
      ctx.strokeStyle = `${colour}66`;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
    }
    circle(ctx, node.x, node.y, 28, "#101c2c");
    ctx.beginPath();
    ctx.arc(node.x, node.y, 27.5, 0, Math.PI * 2);
    ctx.strokeStyle = received.length ? `${colour}99` : "#344156";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    if (node.kind === "llm") {
      const dots = [
        { x: -9, y: -6 },
        { x: 8, y: -9 },
        { x: 10, y: 9 },
        { x: -8, y: 9 },
      ];
      ctx.beginPath();
      dots.forEach((point, index) => {
        if (index === 0) ctx.moveTo(node.x + point.x, node.y + point.y);
        else ctx.lineTo(node.x + point.x, node.y + point.y);
      });
      ctx.closePath();
      ctx.moveTo(node.x - 9, node.y - 6);
      ctx.lineTo(node.x + 10, node.y + 9);
      ctx.stroke();
      dots.forEach((point) =>
        circle(ctx, node.x + point.x, node.y + point.y, 3, "#101c2c"),
      );
      dots.forEach((point) =>
        circle(ctx, node.x + point.x, node.y + point.y, 2, colour),
      );
    } else if (node.kind === "workflow") {
      ctx.strokeRect(node.x - 4, node.y - 11, 8, 7);
      ctx.strokeRect(node.x - 12, node.y + 5, 7, 7);
      ctx.strokeRect(node.x + 5, node.y + 5, 7, 7);
      ctx.beginPath();
      ctx.moveTo(node.x, node.y - 4);
      ctx.lineTo(node.x, node.y + 1);
      ctx.moveTo(node.x - 8.5, node.y + 5);
      ctx.lineTo(node.x - 8.5, node.y + 1);
      ctx.lineTo(node.x + 8.5, node.y + 1);
      ctx.lineTo(node.x + 8.5, node.y + 5);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(node.x - 12, node.y);
      ctx.lineTo(node.x - 6, node.y);
      ctx.lineTo(node.x - 2, node.y - 9);
      ctx.lineTo(node.x + 3, node.y + 9);
      ctx.lineTo(node.x + 7, node.y);
      ctx.lineTo(node.x + 12, node.y);
      ctx.stroke();
    }
    if (received.length)
      circle(
        ctx,
        node.x + 23,
        node.y - 20,
        4,
        hasError ? colours.error : pending ? colours.request : "#70d5a6",
      );
    ctx.textAlign = "center";
    ctx.font = "600 12px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#e0e8f4";
    label(ctx, node.label, node.x, node.y + 45, labelWidth);
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillStyle = "#7f91aa";
    label(
      ctx,
      node.model ??
        (node.kind === "workflow"
          ? "deterministic workflow"
          : node.kind === "client"
            ? "Kubernetes event"
            : node.kind === "tool" ? props.investigation ? "MCP tool adapter" : "deterministic checks"
            : "LLM agent"),
      node.x,
      node.y + 62,
      labelWidth,
    );
  }
  element.dataset.renderWidth = String(w);
  element.dataset.renderHeight = String(h);
  if (pulses.length) frame = requestAnimationFrame(draw);
}

function requestDraw() {
  if (!frame && !disposed) frame = requestAnimationFrame(draw);
}

function select(event: MouseEvent) {
  const bounds = canvas.value?.getBoundingClientRect();
  if (!bounds) return;
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  const node = positions.value.find(
    (item) => Math.hypot(x - item.x, y - item.y) < 38,
  );
  if (node) emit("selectNode", node.id);
}

function motionChange() {
  reducedMotion.value = media?.matches ?? false;
  if (reducedMotion.value) pulses = [];
  requestDraw();
}

watch(
  () => props.arrivals,
  (messages) => {
    if (!reducedMotion.value)
      pulses = [
        ...pulses,
        ...messages.map((message) => ({ message, started: performance.now() })),
      ].slice(-36);
    requestDraw();
  },
);
watch(
  () => [
    props.topology,
    props.messages,
    props.selectedMessage,
    props.selectedNode,
  ],
  requestDraw,
  { deep: true },
);

onMounted(() => {
  media = window.matchMedia("(prefers-reduced-motion: reduce)");
  motionChange();
  media.addEventListener("change", motionChange);
  // draw() reads current geometry. Retaining an older observer entry can
  // temporarily restore the previous responsive height while switching tabs.
  observer = new ResizeObserver(requestDraw);
  if (board.value) observer.observe(board.value);
});

onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  media?.removeEventListener("change", motionChange);
  if (frame) cancelAnimationFrame(frame);
});
</script>

<template>
  <div ref="board" class="graph-board" :class="{ narrow: width < 680 }">
    <canvas
      ref="canvas"
      role="img"
      :aria-label="`Hybrid agent topology. ${description}. Message details are available in the event log below.`"
      @click="select"
    />
    <ul class="sr-only" aria-label="Inspect topology nodes">
      <li v-for="node in topology.nodes" :key="node.id">
        <button @click="emit('selectNode', node.id)">{{ node.label }}</button>
      </li>
    </ul>
    <div v-if="!topology.nodes.length" class="canvas-empty">
      Loading agent topology…
    </div>
    <span v-if="reducedMotion" class="motion-note">Reduced motion enabled</span>
  </div>
</template>
