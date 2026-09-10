import { describe, expect, it } from "vite-plus/test";

import type { TrackerMapRecord } from "../types";
import { byMapOrderThenNumber, mapOrderIndex } from "./map-order";

const maps: TrackerMapRecord[] = [
  {
    mapId: "GH-41",
    title: "First map",
    url: "https://github.com/example/project/issues/41",
    ticketIds: ["GH-42", "GH-7"],
  },
  {
    mapId: "GH-50",
    title: "Second map",
    url: "https://github.com/example/project/issues/50",
    ticketIds: ["GH-7", "GH-51"],
  },
];

describe("map order", () => {
  it("indexes membership position, first map to claim an id keeping it", () => {
    const order = mapOrderIndex(maps);
    expect(order.get("GH-42")).toBe(0);
    expect(order.get("GH-7")).toBe(1);
    expect(order.get("GH-51")).toBe(2);
    expect(order.get("GH-99")).toBeUndefined();
  });

  it("sorts by map order, then issue number ascending for the unmapped", () => {
    const compare = byMapOrderThenNumber(mapOrderIndex(maps));
    const ids = ["GH-9", "GH-51", "GH-7", "GH-42"];
    expect([...ids].sort(compare)).toEqual(["GH-42", "GH-7", "GH-51", "GH-9"]);
  });
});
