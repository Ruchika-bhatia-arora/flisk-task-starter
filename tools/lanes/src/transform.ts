import type { LanePlan } from "./plan";

/** Text files of a project, keyed by their path relative to the project root (forward slashes). */
export type LaneFiles = Map<string, string>;

export interface OptionPair {
  a: string;
  b: string;
}

export interface LaneSpec {
  plan: LanePlan;
  pair: OptionPair;
}

const PROJECT_JSON = ".flisk/project.json";

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Turns the files of a copied Flisk project into an isolated lane: its own project name (which Flisk uses for
 * Compose projects, networks, images and hosts), no host ports or named volumes shared with other copies, and
 * the lane's own vote options and fixed ports.
 */
export function transformLane(files: LaneFiles, lane: LaneSpec): LaneFiles {
  const out: LaneFiles = new Map(files);
  const projectText = files.get(PROJECT_JSON);
  if (projectText !== undefined) {
    const project = JSON.parse(projectText);
    project.project = { ...project.project, name: lane.plan.projectName };
    delete project.composeProjectNames;
    out.set(PROJECT_JSON, toJson(project));
  }
  for (const [path, text] of files) {
    if (!isServiceJson(path)) continue;
    const service = isolateService(JSON.parse(text));
    if (OPTION_SERVICES.has(service.appName)) {
      service.env = { ...service.env, OPTION_A: lane.pair.a, OPTION_B: lane.pair.b };
    }
    out.set(path, toJson(service));
  }
  out.set(".env", laneEnv(files.get(".env") ?? "", lane.plan));
  return out;
}

/**
 * Flisk reads FLISK_HTTP_PORT / FLISK_HTTPS_PORT / FLISK_POSTGRES_PORT from the project's .env
 * (cli/src/utils/host-port-plan.ts:28-32). Pinning them per lane avoids two concurrent `flisk up` runs
 * probing and picking the same free port. TILT_PORT is read from the process env only, so it is passed at spawn.
 */
function laneEnv(baseEnv: string, plan: LanePlan): string {
  const pinned: Record<string, number> = {
    FLISK_HTTP_PORT: plan.ports.http,
    FLISK_HTTPS_PORT: plan.ports.https,
    FLISK_POSTGRES_PORT: plan.ports.postgres,
  };
  // Per-project secrets Flisk generates once ("never shared between projects") are left for the lane to generate.
  const dropped = [...Object.keys(pinned), ...PER_PROJECT_SECRETS];
  const kept = baseEnv
    .split(/\r?\n/)
    .filter((line) => !dropped.some((key) => line.trimStart().startsWith(`${key}=`)));
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  const lines = [...kept, `# Agent Lanes: fixed ports for lane ${plan.name}`];
  for (const [key, value] of Object.entries(pinned)) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

const PER_PROJECT_SECRETS = ["JWT_SECRET"];

/**
 * The vote app reads its two choices from OPTION_A / OPTION_B (vote/app.py:9-10). The results app gets them too:
 * its page hard-codes "Cats"/"Dogs" (result/views/index.html), and with the env set that is fixable in code alone.
 */
const OPTION_SERVICES = new Set(["vote", "result"]);

function isServiceJson(path: string): boolean {
  return path.startsWith("services/") && path.endsWith("/service.json");
}

interface ServiceVolume {
  source: string;
  target: string;
  name?: string;
  [key: string]: unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: service.json is open-ended; only known keys are touched.
function isolateService(service: any): any {
  // Host ports from Compose are published as-is and a busy one fails the container (docs/byo.md:156); the lane is
  // reached through its own Traefik port instead.
  delete service.extraPorts;
  if (Array.isArray(service.volumes)) {
    // A named volume with a fixed `name` is used as-is by Compose (runtime/engine/.../byo_volumes.star:119), so
    // every copy would share it. Without `name` it gets the lane's Compose project prefix.
    service.volumes = service.volumes.map(({ name: _fixedName, ...volume }: ServiceVolume) => volume);
  }
  return service;
}
