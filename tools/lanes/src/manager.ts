import type { ContainerVerb } from "./arena/checks";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { NETWORKS_PER_LANE, networkRoom } from "./capacity";
import { copyProject } from "./copy";
import { type FormPost, postForm } from "./http";
import { withLock } from "./lock";
import type { FliskDriver, LaneStatus, ServiceState, UpResult } from "./driver";
import { LaneError, type LanePlan, planLane } from "./plan";
import { type LaneFiles, type OptionPair, transformLane } from "./transform";

export interface LaneRecord extends LanePlan {
  dir: string;
  pair: OptionPair;
  createdAt: string;
  /** Set on lanes Lane Arena owns; they have their own cap and are replaced by the next race. */
  arena?: true;
}

/** Arena races use three contestants plus a control lane that keeps the original code. */
export const ARENA_LANES = 4;

export interface CreateRequest {
  name?: string;
  pair?: OptionPair;
  arena?: boolean;
}

const LANE_NAMES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];

/** Each lane's vote page asks a different question, so isolation is visible at a glance. Base stays Cats/Dogs. */
export const OPTION_PAIRS: OptionPair[] = [
  { a: "Tabs", b: "Spaces" },
  { a: "Vim", b: "Emacs" },
  { a: "Coffee", b: "Tea" },
  { a: "Monolith", b: "Microservices" },
  { a: "Light mode", b: "Dark mode" },
];

function nextFreeName(existing: Array<{ name: string }>): string {
  const taken = new Set(existing.map((lane) => lane.name));
  return LANE_NAMES.find((name) => !taken.has(name)) ?? `lane${existing.length + 1}`;
}

export type LaneActivity = "starting" | "stopping" | "destroying";
export type LaneState = "stopped" | "starting" | "running" | "failed";

/** A lane as the dashboard shows it: its record, links, and what Flisk reports right now. */
export interface LaneView extends LaneRecord {
  urls: { vote: string; result: string; tilt: string };
  state: LaneState;
  activity: LaneActivity | null;
  services: ServiceState[];
  lastError: string | null;
}

/**
 * Services Flisk reports as "unknown" are not part of the run (seed sits behind its "seed" profile), so they do not
 * hold a lane in "starting".
 */
export function laneState(status: LaneStatus): LaneState {
  if (!status.tiltRunning) return "stopped";
  const active = status.services.filter((service) => service.status !== "unknown");
  if (active.some((service) => service.status === "error")) return "failed";
  if (active.length > 0 && active.every((service) => service.status === "ready")) return "running";
  return "starting";
}

export interface LaneManagerOptions {
  sourceDir: string;
  driver: FliskDriver;
  isPortFree: (port: number) => Promise<boolean>;
  maxLanes?: number;
  /** Sends a form POST and resolves the HTTP status. Defaults to node:http against 127.0.0.1. */
  postForm?: (request: FormPost) => Promise<number>;
  /** How many lanes may run `flisk up` (image builds) at the same time. */
  maxConcurrentStarts?: number;
}

/** `flisk up --wait` names its log file after Date.now() (cli/src/utils/up-wait.ts:138): never start two in one ms. */
const START_STAGGER_MS = 5;

export class LaneManager {
  readonly lanesDir: string;
  private readonly registryPath: string;
  private readonly startSlots: Semaphore;
  private readonly activity = new Map<string, LaneActivity>();
  private readonly lastErrors = new Map<string, string>();
  /** Networks promised to starts still booting: counted as used so parallel starts cannot share the last room. */
  private reservedNetworks = 0;

  constructor(private readonly options: LaneManagerOptions) {
    this.lanesDir = join(options.sourceDir, ".lanes");
    this.registryPath = join(this.lanesDir, "lanes.json");
    this.startSlots = new Semaphore(options.maxConcurrentStarts ?? 2);
  }

  list(): LaneRecord[] {
    if (!existsSync(this.registryPath)) return [];
    return JSON.parse(readFileSync(this.registryPath, "utf8")).lanes;
  }

  /** Creates a lane folder ready for `flisk up`. Without a name or pair, the next free ones are picked. */
  create(request: CreateRequest): Promise<LaneRecord> {
    return withLock(join(this.lanesDir, ".lock"), () => this.createLocked(request));
  }

  private async createLocked(request: CreateRequest): Promise<LaneRecord> {
    const existing = this.list();
    const name = request.name ?? nextFreeName(existing);
    const plan = await planLane(name, existing, this.options.isPortFree, {
      maxLanes: request.arena ? ARENA_LANES : this.options.maxLanes,
      kind: request.arena ? "arena" : "regular",
    });
    const pair = request.pair ?? OPTION_PAIRS[(plan.slot - 1) % OPTION_PAIRS.length];
    const dir = join(this.lanesDir, plan.name);
    copyProject(this.options.sourceDir, dir);
    writeFiles(dir, transformLane(readLaneFiles(dir, this.options.sourceDir), { plan, pair }));
    const record: LaneRecord = { ...plan, dir, pair, createdAt: new Date().toISOString() };
    if (request.arena) record.arena = true;
    this.save([...existing, record]);
    return record;
  }

  get(name: string): LaneRecord {
    const lanes = this.list();
    const lane = lanes.find((candidate) => candidate.name === name);
    if (!lane) {
      const known = lanes.map((candidate) => candidate.name).join(", ") || "none";
      throw new LaneError("UNKNOWN_LANE", `No lane named ${JSON.stringify(name)} (lanes: ${known})`);
    }
    return lane;
  }

  /**
   * Stops the lane's stack, removes its Docker volumes (`flisk down` keeps them) and deletes its folder.
   * Only a folder directly inside .lanes/ is ever deleted.
   */
  destroy(name: string): Promise<void> {
    return withLock(join(this.lanesDir, ".lock"), async () => {
      const lane = this.get(name);
      const dir = this.assertInsideLanes(lane);
      await this.track(name, "destroying", async () => {
        await this.options.driver.down(dir);
        await this.options.driver.removeVolumes(lane.projectName);
      });
      rmSync(dir, { recursive: true, force: true });
      this.save(this.list().filter((candidate) => candidate.name !== name));
      this.lastErrors.delete(name);
    });
  }

  /** Runs `flisk up --wait` for the lane. Waits for a free start slot first (see maxConcurrentStarts). */
  async start(name: string): Promise<UpResult> {
    const lane = this.get(name);
    const dir = this.assertInsideLanes(lane);
    return this.track(name, "starting", async () => {
      const needed = await this.reserveNetworks(lane);
      const release = await this.startSlots.acquire();
      try {
        await Bun.sleep(START_STAGGER_MS);
        const result = await this.options.driver.up(dir, { TILT_PORT: String(lane.ports.tilt) });
        if (result.ok) this.lastErrors.delete(name);
        else this.lastErrors.set(name, result.failures.map((f) => `${f.name}: ${f.message}`).join("\n"));
        return result;
      } finally {
        this.reservedNetworks -= needed;
        release();
      }
    });
  }

  /** How many networks the lane still needs (0 when they exist); refuses when Docker has no subnets left for them. */
  private async reserveNetworks(lane: LaneRecord): Promise<number> {
    const inventory = await this.options.driver.networkInventory();
    const prefix = `${lane.projectName.replace(/-/g, "_")}_`;
    const existing = inventory.names.filter((name) => name.startsWith(prefix)).length;
    const needed = Math.max(0, NETWORKS_PER_LANE - existing);
    const room = networkRoom(inventory.capacity, inventory.names);
    if (needed > room.free - this.reservedNetworks) {
      throw new LaneError(
        "NO_NETWORK_ROOM",
        `Docker has room for ${Math.max(0, room.free - this.reservedNetworks)} more networks (${room.used} of ${room.capacity} in use) and lane ${lane.name} needs ${needed}. Stop a lane (bun run lanes down <name>) or remove one, or give Docker a bigger address pool (see README).`,
      );
    }
    this.reservedNetworks += needed;
    return needed;
  }

  async stop(name: string): Promise<void> {
    const lane = this.get(name);
    const dir = this.assertInsideLanes(lane);
    await this.track(name, "stopping", () => this.options.driver.down(dir));
  }

  async restart(name: string, service: string): Promise<void> {
    const lane = this.get(name);
    await this.options.driver.restart(this.assertInsideLanes(lane), service, lane.ports.tilt);
  }

  /** Every lane with its live state. Flisk is asked about all lanes in parallel. */
  async snapshot(): Promise<LaneView[]> {
    return Promise.all(
      this.list().map(async (lane) => {
        const status = await this.options.driver.status(lane.dir).catch(() => ({ tiltRunning: false, services: [] }));
        const base = `http://api.${lane.projectName}.localhost:${lane.ports.http}`;
        return {
          ...lane,
          urls: { vote: `${base}/api/vote/`, result: `${base}/api/result/`, tilt: `http://localhost:${lane.ports.tilt}` },
          state: laneState(status),
          activity: this.activity.get(lane.name) ?? null,
          services: status.services,
          lastError: this.lastErrors.get(lane.name) ?? null,
        };
      }),
    );
  }

  private async track<T>(name: string, activity: LaneActivity, work: () => Promise<T>): Promise<T> {
    this.activity.set(name, activity);
    try {
      return await work();
    } catch (error) {
      this.lastErrors.set(name, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.activity.delete(name);
    }
  }

  /** Casts `count` votes in the lane, as new voters (no cookie), through the lane's own Traefik. */
  async castVotes(name: string, count: number, choice: "a" | "b"): Promise<{ sent: number; accepted: number }> {
    const lane = this.get(name);
    const post = this.options.postForm ?? postForm;
    const request: FormPost = {
      port: lane.ports.http,
      host: `api.${lane.projectName}.localhost`,
      path: "/api/vote/",
      form: `vote=${choice}`,
    };
    const statuses = await Promise.all(Array.from({ length: count }, () => post(request).catch(() => 0)));
    return { sent: count, accepted: statuses.filter((status) => status >= 200 && status < 400).length };
  }

  async waitForBuilds(name: string, services: string[], sinceMs: number): Promise<void> {
    const lane = this.get(name);
    await this.options.driver.waitForBuilds(this.assertInsideLanes(lane), lane.ports.tilt, services, sinceMs);
  }

  async containerAction(name: string, service: string, verb: ContainerVerb): Promise<void> {
    await this.options.driver.containerAction(this.get(name).projectName, service, verb);
  }

  async restartCount(name: string, service: string): Promise<number> {
    return this.options.driver.restartCount(this.get(name).projectName, service);
  }

  /** Runs one SQL query with psql (tuples only, unaligned) in the lane's own Postgres. */
  async runSql(name: string, sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const lane = this.get(name);
    const result = await this.options.driver.run(this.assertInsideLanes(lane), "db", ["psql", "-U", "postgres", "-tAc", sql]);
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
  }

  /** Reads the votes the worker stored in the lane's own Postgres. */
  async voteCounts(name: string): Promise<{ a: number; b: number }> {
    const lane = this.get(name);
    const result = await this.options.driver.run(this.assertInsideLanes(lane), "db", [
      "psql",
      "-U",
      "postgres",
      "-tAc",
      "select vote, count(*) from votes group by vote",
    ]);
    const counts = { a: 0, b: 0 };
    if (result.exitCode !== 0) {
      // The worker creates the table when it starts; before that nobody can have voted.
      if (/relation "votes" does not exist/.test(result.stderr)) return counts;
      throw new LaneError("COUNT_FAILED", `Could not count votes in lane ${name}: ${result.stderr.trim()}`);
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      const [vote, count] = line.split("|");
      if (vote === "a" || vote === "b") counts[vote] = Number(count);
    }
    return counts;
  }

  private assertInsideLanes(lane: LaneRecord): string {
    const expected = join(realpathSync(this.lanesDir), lane.name);
    const actual = existsSync(lane.dir) ? realpathSync(lane.dir) : lane.dir;
    if (actual !== expected) {
      throw new LaneError(
        "UNSAFE_PATH",
        `Refusing to touch ${lane.dir}: lane ${lane.name} must live at ${expected}. Check .lanes/lanes.json.`,
      );
    }
    return lane.dir;
  }

  private save(lanes: LaneRecord[]): void {
    mkdirSync(this.lanesDir, { recursive: true });
    writeFileSync(this.registryPath, `${JSON.stringify({ lanes }, null, 2)}\n`);
  }
}

/** The files transformLane rewrites: project.json, every service.json, and the base project's .env. */
function readLaneFiles(laneDir: string, sourceDir: string): LaneFiles {
  const files: LaneFiles = new Map();
  const projectJson = join(laneDir, ".flisk", "project.json");
  if (existsSync(projectJson)) files.set(".flisk/project.json", readFileSync(projectJson, "utf8"));
  const baseEnv = join(sourceDir, ".env");
  if (existsSync(baseEnv)) files.set(".env", readFileSync(baseEnv, "utf8"));
  const servicesDir = join(laneDir, "services");
  if (existsSync(servicesDir)) {
    for (const entry of readdirSync(servicesDir, { recursive: true, encoding: "utf8" })) {
      if (entry.split(sep).at(-1) !== "service.json") continue;
      const path = join(servicesDir, entry);
      files.set(relative(laneDir, path).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  }
  return files;
}

function writeFiles(laneDir: string, files: LaneFiles): void {
  for (const [path, text] of files) {
    const target = join(laneDir, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

class Semaphore {
  private waiting: Array<() => void> = [];
  private free: number;

  constructor(size: number) {
    this.free = size;
  }

  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    return () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    };
  }
}
