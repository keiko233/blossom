import { describe, expect, it } from "vitest";

import {
  clearTopologyPositions,
  effectiveTopologyPositions,
  readRailState,
  readTopologyPositions,
  TOPOLOGY_POSITIONS_STORAGE_KEY,
  TOPOLOGY_RAIL_STORAGE_KEY,
  writeRailState,
  writeTopologyPositions,
  type TopologyStorage,
} from "./topology-positions";

function memoryStorage(
  initial: Record<string, string> = {},
): TopologyStorage & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

const throwingStorage: TopologyStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("topology positions", () => {
  it("round-trips positions for known servers", () => {
    const storage = memoryStorage();
    writeTopologyPositions(storage, {
      srv_a: { x: 120, y: -40 },
      srv_b: { x: 340.5, y: 12 },
    });

    expect(readTopologyPositions(storage, ["srv_a", "srv_b"])).toEqual({
      srv_a: { x: 120, y: -40 },
      srv_b: { x: 340.5, y: 12 },
    });
  });

  it("prunes servers that no longer exist", () => {
    const storage = memoryStorage({
      [TOPOLOGY_POSITIONS_STORAGE_KEY]: JSON.stringify({
        srv_a: { x: 1, y: 2 },
        srv_gone: { x: 3, y: 4 },
      }),
    });

    expect(readTopologyPositions(storage, ["srv_a"])).toEqual({
      srv_a: { x: 1, y: 2 },
    });
  });

  it("ignores garbage and non-numeric coordinates", () => {
    const garbage = memoryStorage({
      [TOPOLOGY_POSITIONS_STORAGE_KEY]: "{not json",
    });
    const wrongShape = memoryStorage({
      [TOPOLOGY_POSITIONS_STORAGE_KEY]: JSON.stringify(["a", "b"]),
    });
    const partial = memoryStorage({
      [TOPOLOGY_POSITIONS_STORAGE_KEY]: JSON.stringify({
        srv_a: { x: "10", y: 1 },
        srv_b: { x: 1 },
        srv_c: { x: null, y: 2 },
        srv_d: { x: Number.POSITIVE_INFINITY, y: 0 },
        srv_e: { x: Number.NaN, y: 0 },
        srv_f: { x: 5, y: 6 },
      }),
    });

    expect(readTopologyPositions(garbage, ["srv_a"])).toEqual({});
    expect(readTopologyPositions(wrongShape, ["srv_a"])).toEqual({});
    expect(
      readTopologyPositions(partial, [
        "srv_a",
        "srv_b",
        "srv_c",
        "srv_d",
        "srv_e",
        "srv_f",
      ]),
    ).toEqual({ srv_f: { x: 5, y: 6 } });
  });

  it("never throws when storage itself throws", () => {
    expect(readTopologyPositions(throwingStorage, ["srv_a"])).toEqual({});
    expect(() =>
      writeTopologyPositions(throwingStorage, { srv_a: { x: 0, y: 0 } }),
    ).not.toThrow();
    expect(() => clearTopologyPositions(throwingStorage)).not.toThrow();
  });

  it("clears persisted positions", () => {
    const storage = memoryStorage({
      [TOPOLOGY_POSITIONS_STORAGE_KEY]: JSON.stringify({
        srv_a: { x: 1, y: 2 },
      }),
    });

    clearTopologyPositions(storage);

    expect(storage.entries.has(TOPOLOGY_POSITIONS_STORAGE_KEY)).toBe(false);
    expect(readTopologyPositions(storage, ["srv_a"])).toEqual({});
  });

  it("falls back to the layout position for unpersisted nodes", () => {
    const layout = new Map([
      ["srv_a", { x: 0, y: 0 }],
      ["srv_b", { x: 320, y: 0 }],
    ]);

    expect(
      effectiveTopologyPositions(layout, { srv_b: { x: 10, y: 20 } }),
    ).toEqual(
      new Map([
        ["srv_a", { x: 0, y: 0 }],
        ["srv_b", { x: 10, y: 20 }],
      ]),
    );
  });
});

describe("topology rail state", () => {
  it("defaults to open", () => {
    expect(readRailState(memoryStorage())).toBe("open");
  });

  it("round-trips closed", () => {
    const storage = memoryStorage();
    writeRailState(storage, "closed");

    expect(storage.entries.get(TOPOLOGY_RAIL_STORAGE_KEY)).toBe("closed");
    expect(readRailState(storage)).toBe("closed");
  });

  it("tolerates garbage and throwing storage", () => {
    expect(
      readRailState(memoryStorage({ [TOPOLOGY_RAIL_STORAGE_KEY]: "sideways" })),
    ).toBe("open");
    expect(readRailState(throwingStorage)).toBe("open");
    expect(() => writeRailState(throwingStorage, "closed")).not.toThrow();
  });
});
