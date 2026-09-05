// The flow graph's layout, ported from the approved prototype (decision
// ticket #50) behind the GraphView seam: pure, deterministic functions over
// the graph shape — hand-rolled SVG consumes the boxes; the sanctioned dagre
// swap-in replaces only this module if hand-rolled ordering ever falls short.
//
// Lanes are fixed slots per flow role ("static clustered layout"): the spine
// runs horizontally, the prototype detour bridges beside it, on-ramps merge on
// above, the vocabulary/primitive underlay runs underneath, and the standalone
// shelf plus the in-progress holding pen stack as right-hand columns. Curated
// ids keep their slot; upstream-new (unclassified) ids append after the lane
// alphabetically, so an upstream arrival never displaces a curated node.

import { curatedPenOrder, curatedShelfOrder, skillClassification } from "../data/skill-flow";

export type FlowRegion = "spine" | "detour" | "onramp" | "underlay" | "shelf" | "pen";

export type FlowBox = { x: number; y: number; w: number; h: number };

export type FlowSkill = {
  id: string;
  category: string;
};

const NODE_W: Record<FlowRegion, number> = {
  spine: 170,
  detour: 150,
  onramp: 170,
  underlay: 170,
  shelf: 180,
  pen: 180,
};

const NODE_H: Record<FlowRegion, number> = {
  spine: 56,
  detour: 40,
  onramp: 40,
  underlay: 40,
  shelf: 38,
  pen: 38,
};

const SPINE_ORDER = ["grill-with-docs", "to-spec", "to-tickets", "implement"];
const SPINE_X = [45, 320, 570, 820];
const SPINE_Y = 292;

const DETOUR_IDS = ["handoff", "prototype"];
const DETOUR_POS: Record<string, [number, number]> = { handoff: [210, 168], prototype: [430, 168] };

const ONRAMP_POS: Record<string, [number, number]> = {
  wayfinder: [45, 44],
  triage: [420, 44],
  "diagnosing-bugs": [700, 44],
};

const UNDERLAY_ORDER = ["grilling", "domain-modeling", "codebase-design"];
const UNDERLAY_X = [45, 265, 485];
const UNDERLAY_Y = 470;

const SHELF_X = 1080;
const SHELF_Y = 76;
const SHELF_PITCH = 45;
const PEN_X = 1290;

export const flowCanvasSize = { width: 1500, height: 880 };

export const flowRegionFor = ({ id, category }: FlowSkill): FlowRegion => {
  const role = skillClassification(id)?.role ?? null;
  if (role === "main-flow") return DETOUR_IDS.includes(id) ? "detour" : "spine";
  if (role === "on-ramp") return "onramp";
  if (role === "vocabulary" || role === "primitive") return "underlay";
  return category === "in-progress" ? "pen" : "shelf";
};

// Lane stacking order: curated ids keep their declared slot; anything else
// (upstream-new) appends after the whole curated lane, sorted by id.
const laneOrder = (present: string[], curated: string[]): string[] => {
  const curatedSet = new Set(curated);
  const ordered = curated.filter((id) => present.includes(id));
  const extras = present.filter((id) => !curatedSet.has(id)).sort();
  return [...ordered, ...extras];
};

// One stacked lane: curated slots then extras, pitched vertically at x.
const stackLane = (
  boxes: Record<string, FlowBox>,
  ids: string[],
  curated: string[],
  x: number,
  w: number,
  h: number,
) => {
  const extras = ids.filter((id) => !curated.includes(id));
  for (const id of ids) {
    const curatedIndex = curated.indexOf(id);
    const index = curatedIndex === -1 ? curated.length + extras.indexOf(id) : curatedIndex;
    boxes[id] = { x, y: SHELF_Y + index * SHELF_PITCH, w, h };
  }
};

export const layoutFlowGraph = (skills: FlowSkill[]): Record<string, FlowBox> => {
  const boxes: Record<string, FlowBox> = {};
  const present = (id: string) => skills.some((s) => s.id === id);

  SPINE_ORDER.filter(present).forEach((id, index) => {
    boxes[id] = { x: SPINE_X[index], y: SPINE_Y, w: NODE_W.spine, h: NODE_H.spine };
  });

  for (const id of DETOUR_IDS) {
    if (!present(id)) continue;
    const [x, y] = DETOUR_POS[id];
    boxes[id] = { x, y, w: NODE_W.detour, h: NODE_H.detour };
  }

  for (const [id, [x, y]] of Object.entries(ONRAMP_POS)) {
    if (present(id)) boxes[id] = { x, y, w: NODE_W.onramp, h: NODE_H.onramp };
  }

  UNDERLAY_ORDER.filter(present).forEach((id, index) => {
    boxes[id] = { x: UNDERLAY_X[index], y: UNDERLAY_Y, w: NODE_W.underlay, h: NODE_H.underlay };
  });

  const regionIds = (region: FlowRegion) =>
    skills.filter((s) => flowRegionFor(s) === region).map((s) => s.id);
  stackLane(
    boxes,
    laneOrder(regionIds("shelf"), curatedShelfOrder),
    curatedShelfOrder,
    SHELF_X,
    NODE_W.shelf,
    NODE_H.shelf,
  );
  stackLane(
    boxes,
    laneOrder(regionIds("pen"), curatedPenOrder),
    curatedPenOrder,
    PEN_X,
    NODE_W.pen,
    NODE_H.pen,
  );

  return boxes;
};

// Edge geometry: pick anchors by dominant direction, then a cubic curve.
export const flowEdgePath = (a: FlowBox, b: FlowBox): string => {
  const acx = a.x + a.w / 2;
  const bcx = b.x + b.w / 2;
  const acy = a.y + a.h / 2;
  const bcy = b.y + b.h / 2;
  const dx = bcx - acx;
  const dy = bcy - acy;
  let p1: [number, number];
  let p2: [number, number];
  if (Math.abs(dy) >= Math.abs(dx) * 0.9) {
    const down = dy > 0;
    p1 = [acx, down ? a.y + a.h : a.y];
    p2 = [bcx, down ? b.y : b.y + b.h];
  } else if (dx > 0) {
    p1 = [a.x + a.w, acy];
    p2 = [b.x, bcy];
  } else {
    p1 = [a.x, acy];
    p2 = [b.x + b.w, bcy];
  }
  const mx = (p1[0] + p2[0]) / 2;
  return `M ${p1[0]} ${p1[1]} C ${mx} ${p1[1]}, ${mx} ${p2[1]}, ${p2[0]} ${p2[1]}`;
};

export const flowRegionLabels = (): Array<{ x: number; y: number; text: string }> => [
  { text: "on-ramps — generate work, merge on", x: 45, y: 30 },
  { text: "main flow — idea → ship", x: 45, y: 276 },
  { text: "vocabulary + primitives — run underneath", x: 45, y: 458 },
  { text: "standalone — off the flow", x: SHELF_X, y: 60 },
  { text: "upstream · in progress — unclassified", x: PEN_X, y: 60 },
];
