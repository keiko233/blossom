/**
 * Per-viewer topology preferences in `localStorage`: manually dragged node
 * positions and the inspector rail state. Every read validates and prunes, and
 * every write is best-effort, because storage can be disabled, full or hold
 * data written by another version.
 */

export interface TopologyPosition {
  x: number;
  y: number;
}

export type TopologyPositions = Readonly<Record<string, TopologyPosition>>;
export type TopologyRailState = "open" | "closed";

export const TOPOLOGY_POSITIONS_STORAGE_KEY = "blossom.topology.positions.v1";
export const TOPOLOGY_RAIL_STORAGE_KEY = "blossom.topology.rail.v1";

export type TopologyStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function isPosition(value: unknown): value is TopologyPosition {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { x?: unknown; y?: unknown };
  return (
    typeof candidate.x === "number" &&
    Number.isFinite(candidate.x) &&
    typeof candidate.y === "number" &&
    Number.isFinite(candidate.y)
  );
}

function parsePositions(raw: string | null): Record<string, TopologyPosition> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const positions: Record<string, TopologyPosition> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!id || !isPosition(value)) continue;
    positions[id] = { x: value.x, y: value.y };
  }
  return positions;
}

/**
 * Reads persisted positions, dropping ids that no longer exist and values
 * that are not finite numbers. Never throws.
 */
export function readTopologyPositions(
  storage: TopologyStorage,
  knownIds: Iterable<string>,
): Record<string, TopologyPosition> {
  let raw: string | null = null;
  try {
    raw = storage.getItem(TOPOLOGY_POSITIONS_STORAGE_KEY);
  } catch {
    return {};
  }

  const parsed = parsePositions(raw);
  const known = new Set(knownIds);
  const positions: Record<string, TopologyPosition> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!known.has(id)) continue;
    positions[id] = value;
  }
  return positions;
}

export function writeTopologyPositions(
  storage: TopologyStorage,
  positions: TopologyPositions,
): void {
  try {
    storage.setItem(TOPOLOGY_POSITIONS_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Storage can be unavailable (private mode, quota); positions reset.
  }
}

export function clearTopologyPositions(storage: TopologyStorage): void {
  try {
    storage.removeItem(TOPOLOGY_POSITIONS_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

export function readRailState(storage: TopologyStorage): TopologyRailState {
  try {
    return storage.getItem(TOPOLOGY_RAIL_STORAGE_KEY) === "closed"
      ? "closed"
      : "open";
  } catch {
    return "open";
  }
}

export function writeRailState(
  storage: TopologyStorage,
  state: TopologyRailState,
): void {
  try {
    storage.setItem(TOPOLOGY_RAIL_STORAGE_KEY, state);
  } catch {
    // Rail state simply does not persist.
  }
}

/**
 * The effective position of a node: a persisted drag when one exists for a
 * known node, otherwise the computed layout position.
 */
export function effectiveTopologyPositions(
  layout: ReadonlyMap<string, TopologyPosition>,
  persisted: TopologyPositions,
): Map<string, TopologyPosition> {
  const positions = new Map<string, TopologyPosition>();
  for (const [id, point] of layout) {
    positions.set(id, persisted[id] ?? point);
  }
  return positions;
}
