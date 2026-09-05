import { describe, expect, it } from "vite-plus/test";

import {
  flowCanvasSize,
  flowEdgePath,
  flowRegionFor,
  flowRegionLabels,
  layoutFlowGraph,
  type FlowBox,
} from "./flow-layout";

const skill = (id: string, category = "engineering") => ({ id, category });

const box = (x: number, y: number, w: number, h: number): FlowBox => ({ x, y, w, h });

describe("flow region derivation", () => {
  it("assigns curated roles to their prototype lanes", () => {
    expect(flowRegionFor(skill("grill-with-docs"))).toBe("spine");
    expect(flowRegionFor(skill("handoff"))).toBe("detour");
    expect(flowRegionFor(skill("wayfinder"))).toBe("onramp");
    expect(flowRegionFor(skill("grilling"))).toBe("underlay");
    expect(flowRegionFor(skill("domain-modeling"))).toBe("underlay");
    expect(flowRegionFor(skill("tdd"))).toBe("shelf");
  });

  it("sends unclassified skills to the shelf unless upstream holds them in progress", () => {
    expect(flowRegionFor(skill("brand-new-skill", "engineering"))).toBe("shelf");
    expect(flowRegionFor(skill("brand-new-skill", "productivity"))).toBe("shelf");
    expect(flowRegionFor(skill("just-landed", "in-progress"))).toBe("pen");
  });
});

describe("flow graph layout", () => {
  const full = layoutFlowGraph([
    ...["grill-with-docs", "to-spec", "to-tickets", "implement"].map((id) => skill(id)),
    skill("handoff", "productivity"),
    skill("prototype"),
    skill("wayfinder"),
    skill("triage"),
    skill("diagnosing-bugs"),
    skill("grilling", "productivity"),
    skill("domain-modeling"),
    skill("codebase-design"),
    ...["tdd", "code-review", "ask-matt"].map((id) => skill(id)),
    skill("retro", "in-progress"),
  ]);

  it("lays the spine out horizontally in flow order with fixed node boxes", () => {
    expect(full["grill-with-docs"]).toEqual(box(45, 292, 170, 56));
    expect(full["to-spec"]).toEqual(box(320, 292, 170, 56));
    expect(full["to-tickets"]).toEqual(box(570, 292, 170, 56));
    expect(full["implement"]).toEqual(box(820, 292, 170, 56));
  });

  it("keeps the prototype detour beside the spine and the on-ramps above", () => {
    expect(full["handoff"]).toEqual(box(210, 168, 150, 40));
    expect(full["prototype"]).toEqual(box(430, 168, 150, 40));
    expect(full["wayfinder"]).toEqual(box(45, 44, 170, 40));
    expect(full["diagnosing-bugs"]).toEqual(box(700, 44, 170, 40));
  });

  it("stacks the underlay and the shelf lanes at fixed x columns", () => {
    expect(full["grilling"]).toEqual(box(45, 470, 170, 40));
    expect(full["domain-modeling"]).toEqual(box(265, 470, 170, 40));
    expect(full["tdd"]).toEqual(box(1080, 76, 180, 38));
    expect(full["code-review"]).toEqual(box(1080, 121, 180, 38));
  });

  it("appends unclassified shelf skills after the curated slots, alphabetically", () => {
    expect(full["ask-matt"]).toEqual(box(1080, 76 + 6 * 45, 180, 38));
    const extra = layoutFlowGraph([skill("tdd"), skill("aardvark"), skill("zephyr")]);
    expect(extra["tdd"]).toEqual(box(1080, 76, 180, 38));
    expect(extra["aardvark"]).toEqual(box(1080, 76 + 17 * 45, 180, 38));
    expect(extra["zephyr"]).toEqual(box(1080, 76 + 18 * 45, 180, 38));
  });

  it("places the in-progress holding pen as the right-hand column", () => {
    expect(full["retro"]).toEqual(box(1290, 76 + 3 * 45, 180, 38));
  });

  it("is deterministic for identical input", () => {
    expect(layoutFlowGraph([skill("tdd"), skill("implement")])).toEqual(
      layoutFlowGraph([skill("tdd"), skill("implement")]),
    );
  });

  it("fits the declared canvas", () => {
    expect(flowCanvasSize).toEqual({ width: 1500, height: 880 });
    for (const b of Object.values(full)) {
      expect(b.x + b.w).toBeLessThanOrEqual(flowCanvasSize.width);
      expect(b.y + b.h).toBeLessThanOrEqual(flowCanvasSize.height);
    }
  });
});

describe("flow edge geometry", () => {
  it("anchors horizontal edges on facing sides", () => {
    const from = box(820, 292, 170, 56);
    const to = box(1080, 76, 180, 38);
    const path = flowEdgePath(from, to);
    expect(path).toMatch(/^M 990 320 C /);
    expect(path).toMatch(/1080 95$/);
  });

  it("anchors vertical edges bottom-to-top", () => {
    const from = box(45, 292, 170, 56);
    const to = box(45, 470, 170, 40);
    const path = flowEdgePath(from, to);
    expect(path).toMatch(/^M 130 348 C /);
    expect(path).toMatch(/130 470$/);
  });
});

describe("flow region labels", () => {
  it("labels the five regions of the landing design", () => {
    const labels = flowRegionLabels();
    expect(labels.map((label) => label.text)).toEqual([
      "on-ramps — generate work, merge on",
      "main flow — idea → ship",
      "vocabulary + primitives — run underneath",
      "standalone — off the flow",
      "upstream · in progress — unclassified",
    ]);
  });
});
