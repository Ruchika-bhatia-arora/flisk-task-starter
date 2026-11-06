import type { ContainerVerb } from "./checks";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpResult } from "../driver";
import type { LaneRecord } from "../manager";
import type { OptionPair } from "../transform";
import type { AgentResult, AgentRunner } from "./agent";
import { type CheckIO, type CheckResult, type CheckTiming, runChecks } from "./checks";
import { applyToBase, diffLane, type LaneDiff } from "./diff";
import { type ArenaTask, findTask } from "./tasks";

/** The three contestants: lane name and the Claude model that works in it. */
export const CONTESTANTS = [
  { model: "haiku", modelId: "claude-haiku-5-5" },
  { model: "sonnet", modelId: "claude-sonnet-5-5" },
  { model: "opus", modelId: "claude-opus-5-5" },
] as const;

export type ContestantModel = (typeof CONTESTANTS)[number]["model"];
export type Stage = "queued" | "lane" | "agent" | "restart" | "checks" | "done";
export type ContestantStatus = "passed" | "failed" | "over_budget" | "agent_error" | "lane_failed" | "unverified";

export interface Contestant {
  model: ContestantModel;
  modelId: string;
  lane: string;
  stage: Stage;
  status?: ContestantStatus;
  rank?: number;
  agent?: AgentResult;
  checks?: CheckResult[];
  diff?: Omit<LaneDiff, "patch">;
  error?: string;
}

export interface ArenaRun {
  id: string;
  /** Regular lanes stopped to make room (Docker subnets) and started again after the race. */
  paused?: string[];
  /** Things that went wrong around the race itself, e.g. a paused lane that did not come back. */
  notes?: string[];
  /** The task's checks run on an untouched copy of the app: proof that they fail without the change. */
  baseline?: { passed: number; total: number; checks?: CheckResult[]; error?: string };
  task: { id: string; title: string; difficulty: string; request: string; unverified: boolean };
  pair: OptionPair;
  startedAt: string;
  finishedAt?: string;
  contestants: Contestant[];
}

/** What the Arena needs from the lane manager. */
export interface ArenaLanes {
  list(): LaneRecord[];
  snapshot(): Promise<Array<{ name: string; arena?: true; state: string }>>;
  stop(name: string): Promise<void>;
  create(request: { name?: string; pair?: OptionPair; arena?: boolean }): Promise<LaneRecord>;
  start(name: string): Promise<UpResult>;
  destroy(name: string): Promise<void>;
  restart(name: string, service: string): Promise<void>;
  runSql(name: string, sql: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** Waits until Tilt has rebuilt these services after `sinceMs` (compiled services need a new image). */
  waitForBuilds(name: string, services: string[], sinceMs: number): Promise<void>;
  containerAction(name: string, service: string, verb: ContainerVerb): Promise<void>;
  restartCount(name: string, service: string): Promise<number>;
}

/** The lane that keeps the original code, to prove a task's checks fail without the change. */
const CONTROL_LANE = "control";

export interface ArenaOptions {
  baseDir: string;
  lanes: ArenaLanes;
  agent: AgentRunner;
  /** One HTTP request to a lane's live app, through its Traefik. */
  http(lane: LaneRecord, request: { method: "GET" | "POST"; path: string; form?: string }): Promise<{ status: number; body: string }>;
  diff?: (baseDir: string, laneDir: string) => Promise<LaneDiff>;
  /** Writes the lane-only helper scripts the agent may run. */
  prepareLane?: (lane: LaneRecord) => void;
  budgetUsd?: number;
  agentTimeoutMs?: number;
  checkTiming?: CheckTiming;
  /** Clock used by the checks (waits and retries); tests pass a fake one. */
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

/** Every contestant gets the same question, so results compare like for like. */
const RACE_PAIR: OptionPair = { a: "Tabs", b: "Spaces" };

export class Arena {
  private readonly runsDir: string;
  private current: ArenaRun | null = null;

  constructor(private readonly options: ArenaOptions) {
    this.runsDir = join(options.baseDir, ".arena", "runs");
  }

  /** Starts a race lane again so its version can be tried live (after the race they are set aside). */
  async startLane(model: string): Promise<UpResult> {
    const contestant = CONTESTANTS.find((candidate) => candidate.model === model);
    if (!contestant) throw new Error(`No contestant ${model}`);
    return this.options.lanes.start(contestant.model);
  }

  isRunning(): boolean {
    return this.current !== null && this.current.finishedAt === undefined;
  }

  /** The race in progress, or the most recent one saved on disk. */
  latest(): ArenaRun | null {
    if (this.current) return this.current;
    if (!existsSync(this.runsDir)) return null;
    const newest = readdirSync(this.runsDir).sort().at(-1);
    return newest ? this.load(newest) : null;
  }

  /** The unified diff a contestant produced in a race. */
  patch(runId: string, model: string): string {
    const path = join(this.runsDir, safeId(runId), `${safeId(model)}.patch`);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  /**
   * Writes a contestant's change into the base app, backing up every file it overwrites or deletes to
   * .arena/backups/<run>/<model>/. Only a contestant whose checks passed (or an unverified one) can be applied.
   */
  async apply(runId: string, model: string): Promise<string[]> {
    const run = this.current?.id === runId ? this.current : this.load(runId);
    const contestant = run?.contestants.find((candidate) => candidate.model === model);
    if (!run || !contestant) throw new Error(`No contestant ${model} in race ${runId}`);
    if (contestant.status !== "passed" && contestant.status !== "unverified") {
      throw new Error(`${model} did not pass its checks (${contestant.status ?? "not finished"}), so it is not applied`);
    }
    const lane = this.options.lanes.list().find((candidate) => candidate.name === contestant.lane);
    if (!lane) throw new Error(`Lane ${contestant.lane} is gone, so ${model}'s change can no longer be applied`);
    const diff = await (this.options.diff ?? diffLane)(this.options.baseDir, lane.dir);
    return applyToBase(this.options.baseDir, lane.dir, diff, join(this.options.baseDir, ".arena", "backups", run.id, model));
  }

  private load(runId: string): ArenaRun | null {
    const path = join(this.runsDir, safeId(runId), "run.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  }

  private save(run: ArenaRun): void {
    mkdirSync(join(this.runsDir, run.id), { recursive: true });
    writeFileSync(join(this.runsDir, run.id, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  }

  /** Starts a race. `finished` resolves when every contestant is done; `run` is updated as it goes. */
  start(request: { taskId?: string; freeText?: string }): { run: ArenaRun; finished: Promise<ArenaRun> } {
    const task = request.taskId ? findTask(request.taskId) : undefined;
    const run: ArenaRun = {
      id: runId(new Date()),
      task: task
        ? { id: task.id, title: task.title, difficulty: task.difficulty, request: task.request, unverified: false }
        : { id: "free-text", title: request.freeText ?? "", difficulty: "custom", request: request.freeText ?? "", unverified: true },
      pair: RACE_PAIR,
      startedAt: new Date().toISOString(),
      contestants: CONTESTANTS.map((c) => ({ model: c.model, modelId: c.modelId, lane: c.model, stage: "queued" })),
    };
    this.current = run;
    this.save(run);
    const finished = this.race(run, task);
    return { run, finished };
  }

  private async race(run: ArenaRun, task: ArenaTask | undefined): Promise<ArenaRun> {
    // The previous race's lanes go; regular lanes (alpha, beta, ...) are never touched.
    const { lanes } = this.options;
    for (const lane of lanes.list().filter((candidate) => candidate.arena)) {
      await lanes.destroy(lane.name);
    }
    // Each stack takes 7 Docker networks and the default pools hold ~31, so running regular lanes step aside.
    const paused = (await lanes.snapshot()).filter((lane) => !lane.arena && lane.state !== "stopped").map((l) => l.name);
    for (const name of paused) await lanes.stop(name);
    run.paused = paused;
    this.save(run);

    await Promise.all([
      ...run.contestants.map((contestant) => this.compete(run, contestant, task)),
      task && task.checks.length > 0 ? this.runBaseline(run, task) : Promise.resolve(),
    ]);
    rank(run.contestants);
    if (run.baseline && run.baseline.total > 0 && run.baseline.passed === run.baseline.total) {
      (run.notes ??= []).push("The original code already passes every check, so this race proves nothing about the change.");
    }

    // Race lanes are set aside (folders kept for diffs, "apply" and "start lane"), then paused lanes come back.
    const raceLanes = [...run.contestants.map((c) => c.lane), ...(run.baseline ? [CONTROL_LANE] : [])];
    for (const name of raceLanes) {
      await lanes.stop(name).catch(() => undefined);
    }
    for (const name of paused) {
      const up = await lanes.start(name).catch((error: unknown) => ({
        ok: false,
        failures: [{ name, message: error instanceof Error ? error.message : String(error) }],
      }));
      if (!up.ok) (run.notes ??= []).push(`${name} did not start again: ${up.failures.map((f) => f.message).join("; ")}`);
    }
    run.finishedAt = new Date().toISOString();
    this.save(run);
    return run;
  }

  /**
   * Proves a task without racing: its checks run on a fresh control lane with the original code, and no agent
   * (no API cost). A valid task fails here; a task the original code already passes proves nothing.
   */
  async prove(taskId: string): Promise<NonNullable<ArenaRun["baseline"]>> {
    const task = findTask(taskId);
    if (!task) throw new Error(`No preset task ${taskId}`);
    const { lanes } = this.options;
    if (lanes.list().some((lane) => lane.name === CONTROL_LANE)) await lanes.destroy(CONTROL_LANE);
    const holder = { pair: RACE_PAIR } as ArenaRun;
    await this.runBaseline(holder, task, false);
    await lanes.stop(CONTROL_LANE).catch(() => undefined);
    return holder.baseline ?? { passed: 0, total: task.checks.length, error: "not run" };
  }

  /** Runs the task's checks on an untouched lane. No agent works there. */
  private async runBaseline(run: ArenaRun, task: ArenaTask, persist = true): Promise<void> {
    const { lanes } = this.options;
    run.baseline = { passed: 0, total: task.checks.length };
    try {
      const lane = await lanes.create({ name: CONTROL_LANE, pair: run.pair, arena: true });
      const up = await lanes.start(lane.name);
      if (!up.ok) {
        run.baseline.error = up.failures.map((f) => `${f.name}: ${f.message}`).join("\n");
        return;
      }
      const checks = await runChecks(task.checks, { A: run.pair.a, B: run.pair.b }, this.checkIO(lane), this.options.checkTiming);
      run.baseline = { passed: checks.filter((check) => check.passed).length, total: checks.length, checks };
    } catch (error) {
      run.baseline.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (persist) this.save(run);
    }
  }

  private checkIO(lane: LaneRecord): CheckIO {
    const { lanes } = this.options;
    return {
      http: (request) => this.options.http(lane, request),
      sql: (query) => lanes.runSql(lane.name, query),
      action: (verb, service) => lanes.containerAction(lane.name, service, verb),
      restartCount: (service) => lanes.restartCount(lane.name, service),
      now: () => (this.options.clock ? this.options.clock.now() : Date.now()),
      sleep: (ms) => (this.options.clock ? this.options.clock.sleep(ms) : Bun.sleep(ms)),
    };
  }

  private async compete(run: ArenaRun, contestant: Contestant, task: ArenaTask | undefined): Promise<void> {
    const { lanes } = this.options;
    contestant.stage = "lane";
    const lane = await lanes.create({ name: contestant.lane, pair: run.pair, arena: true });
    const up = await lanes.start(lane.name);
    if (!up.ok) {
      contestant.status = "lane_failed";
      contestant.error = up.failures.map((failure) => `${failure.name}: ${failure.message}`).join("\n");
      contestant.stage = "done";
      return;
    }
    this.options.prepareLane?.(lane);

    contestant.stage = "agent";
    const agent = await this.options.agent.run({
      laneDir: lane.dir,
      model: contestant.modelId,
      prompt: buildPrompt(run, task, lane),
      budgetUsd: task?.budgetUsd ?? this.options.budgetUsd ?? 1,
      timeoutMs: this.options.agentTimeoutMs ?? 10 * 60_000,
    });
    const agentDone = Date.now();
    const { raw, ...result } = agent;
    contestant.agent = result;
    if (raw !== undefined) {
      mkdirSync(join(this.runsDir, run.id), { recursive: true });
      writeFileSync(join(this.runsDir, run.id, `${contestant.model}.agent.json`), raw);
    }
    const diff = await (this.options.diff ?? diffLane)(this.options.baseDir, lane.dir);
    contestant.diff = { files: diff.files, added: diff.added, removed: diff.removed };
    mkdirSync(join(this.runsDir, run.id), { recursive: true });
    writeFileSync(join(this.runsDir, run.id, `${contestant.model}.patch`), diff.patch);
    this.save(run);

    contestant.stage = "restart";
    const changed = changedServices(diff);
    if (changed.length > 0) {
      await lanes.waitForBuilds(lane.name, changed, agentDone).catch((error: unknown) => {
        contestant.error = `waiting for the rebuild failed: ${error instanceof Error ? error.message : String(error)}`;
      });
    }
    for (const service of changed) {
      await lanes.restart(lane.name, service).catch((error: unknown) => {
        contestant.error = `restart ${service} failed: ${error instanceof Error ? error.message : String(error)}`;
      });
    }

    contestant.stage = "checks";
    contestant.checks = await runChecks(
      task?.checks ?? [],
      { A: run.pair.a, B: run.pair.b },
      this.checkIO(lane),
      this.options.checkTiming,
    );
    contestant.status = outcomeStatus(result, contestant.checks, task === undefined);
    contestant.stage = "done";
  }
}

/** Folders whose code is served by a Flisk service of the same name. */
const SERVICE_DIRS: Record<string, string> = { vote: "vote", result: "result", worker: "worker" };

function changedServices(diff: LaneDiff): string[] {
  const services = new Set<string>();
  for (const file of diff.files) {
    const service = SERVICE_DIRS[file.path.split("/")[0]];
    if (service) services.add(service);
  }
  return [...services];
}

function outcomeStatus(agent: AgentResult, checks: CheckResult[], unverified: boolean): ContestantStatus {
  if (checks.length > 0 && checks.every((check) => check.passed)) return "passed";
  if (agent.outcome === "over_budget") return "over_budget";
  if (agent.outcome === "error") return "agent_error";
  return unverified ? "unverified" : "failed";
}

/** All checks passed first, then more checks passed, then cheaper, then faster. */
function rank(contestants: Contestant[]): void {
  const passedCount = (c: Contestant) => c.checks?.filter((check) => check.passed).length ?? 0;
  const sorted = [...contestants].sort(
    (x, y) =>
      Number(y.status === "passed") - Number(x.status === "passed") ||
      passedCount(y) - passedCount(x) ||
      (x.agent?.costUsd ?? Infinity) - (y.agent?.costUsd ?? Infinity) ||
      (x.agent?.durationMs ?? Infinity) - (y.agent?.durationMs ?? Infinity),
  );
  sorted.forEach((contestant, index) => {
    contestant.rank = index + 1;
  });
}

/** Run ids and model names become path segments: letters, digits and hyphens only. */
function safeId(value: string): string {
  if (!/^[a-z0-9-]+$/i.test(value)) throw new Error(`Invalid id ${JSON.stringify(value)}`);
  return value;
}

function runId(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/** The same frame for every contestant: the app, its live lane, the rules, the task and its acceptance checks. */
export function buildPrompt(run: ArenaRun, task: ArenaTask | undefined, lane: LaneRecord): string {
  const criteria = task
    ? task.checks.map((check) => `- ${check.label}`).join("\n")
    : "- (none given: this race is unverified)";
  return [
    "You are working on a voting app in the current directory. Services: vote (Python/Flask, vote/),",
    "result (Node.js/Express + socket.io + Angular page, result/), worker (.NET, worker/; moves votes from Redis",
    "to Postgres), redis, and Postgres (table votes(id, vote)).",
    `The app is running live for you as Flisk project ${lane.projectName}. Its options are`,
    `OPTION_A="${run.pair.a}" and OPTION_B="${run.pair.b}" (set in the environment of vote and result).`,
    "Check the live app with ./.arena-tools/lane-curl <path> [-d <form>] (for example ./.arena-tools/lane-curl /api/vote/),",
    "and service health with ./.arena-tools/lane-status. These two are the ONLY shell commands you may run, each",
    "on its own: no pipes, no cd, no &&, no other programs (anything else is refused). Paths /api/vote/... reach the vote app at /...,",
    "/api/result/... reach the results app at /.... After you finish, the services whose code you changed are",
    "restarted and the acceptance checks below are run against the live app.",
    "Rules: change only app code under vote/, result/, worker/. Do not edit services/, .flisk/, .env or",
    "docker-compose.yml. There is no git here. Keep the change small and focused.",
    "",
    `Task: ${run.task.request}`,
    "",
    "Acceptance checks:",
    criteria,
    "",
    "When done, reply with a short summary of what you changed.",
  ].join("\n");
}
