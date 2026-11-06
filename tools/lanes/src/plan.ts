export class LaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LaneError";
  }
}

export interface LanePorts {
  http: number;
  https: number;
  postgres: number;
  tilt: number;
}

export interface LanePlan {
  name: string;
  projectName: string;
  slot: number;
  ports: LanePorts;
}

export function portsForSlot(slot: number): LanePorts {
  return { http: 19080 + slot, https: 19443 + slot, postgres: 19532 + slot, tilt: 10400 + slot };
}

async function slotPortsFree(
  slot: number,
  isPortFree: (port: number) => Promise<boolean>,
): Promise<boolean> {
  for (const port of Object.values(portsForSlot(slot))) {
    if (!(await isPortFree(port))) return false;
  }
  return true;
}

/** Lowercase letters and digits only: no hyphen or underscore, so one lane's Flisk project name can never be another's plus a separator. */
const LANE_NAME = /^[a-z][a-z0-9]{0,11}$/;
const RESERVED = new Set(["base", "main", "lane", "lanes", "flisk", "traefik", "proxy"]);
export const DEFAULT_MAX_LANES = 3;

export type LaneKind = "regular" | "arena";

export interface PlanOptions {
  maxLanes?: number;
  /** Arena lanes have their own cap; slots and names stay unique across every lane. */
  kind?: LaneKind;
}

/** What planLane needs to know about lanes that already exist. */
export interface ExistingLane {
  name: string;
  slot: number;
  arena?: boolean;
}

export async function planLane(
  name: string,
  existing: ExistingLane[],
  isPortFree: (port: number) => Promise<boolean>,
  options: PlanOptions = {},
): Promise<LanePlan> {
  if (!LANE_NAME.test(name) || RESERVED.has(name)) {
    throw new LaneError(
      "INVALID_NAME",
      `Lane name ${JSON.stringify(name)} must be 1-12 lowercase letters or digits, start with a letter, and not be one of: ${[...RESERVED].join(", ")}`,
    );
  }
  if (existing.some((lane) => lane.name === name)) {
    throw new LaneError("NAME_TAKEN", `A lane named ${name} already exists`);
  }
  const maxLanes = options.maxLanes ?? DEFAULT_MAX_LANES;
  const arena = options.kind === "arena";
  const sameKind = existing.filter((lane) => Boolean(lane.arena) === arena).length;
  if (sameKind >= maxLanes) {
    const what = arena ? "arena lanes" : "lanes";
    throw new LaneError(
      "LANE_CAP",
      `${sameKind} ${what} already exist (cap ${maxLanes}). Remove one, or raise the cap with --max (each lane runs ~5 containers, ~280 MiB idle).`,
    );
  }
  const used = new Set(existing.map((lane) => lane.slot));
  let slot = 1;
  while (used.has(slot) || !(await slotPortsFree(slot, isPortFree))) slot++;
  return { name, projectName: `${name}-lane`, slot, ports: portsForSlot(slot) };
}
