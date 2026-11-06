#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ClaudeAgent } from "./arena/agent";
import { Arena, type ArenaRun } from "./arena/arena";
import { writeLaneTools } from "./arena/lane-tools";
import { ARENA_TASKS } from "./arena/tasks";
import { isPortFree, RealFlisk } from "./flisk";
import { laneRequest } from "./http";
import { LaneManager } from "./manager";
import { LaneError } from "./plan";
import { startDashboard } from "./server";

const HELP = `Agent Lanes: several isolated copies of this Flisk app, side by side.

Usage: bun run lanes <command> [options]

  create [name|count]   Copy the app into .lanes/<name> and start it (count: that many auto-named lanes)
        --pair "A,B"      the lane's two vote options (default: a different pair per lane)
        --no-start        only create the folder
        --max N           lane cap (default 3)
  ls                    List lanes with live state and URLs
  up <name>             Start a lane (flisk up --wait)
  down <name>           Stop a lane, keep its folder and data
  rm <name>             Stop a lane, delete its volumes and folder
  votes <name> [n] [a|b]  Cast n votes (default 10, a) and print the lane's counts
  dash [--port 7357]    Live control room in the browser (includes Lane Arena)
  arena tasks           List the preset Arena races
  arena <task-id>       Race Haiku, Sonnet and Opus on a preset task in lanes haiku/sonnet/opus
  arena "free text"     Race on any request (unverified: no acceptance checks)
  arena prove <task-id> Run a task's checks on the original code only (no agents, no API cost)
                        Agents are capped per task ($1, or the task's own cap; --budget for tasks without
                        one); racing needs ANTHROPIC_API_KEY

Lanes live in .lanes/ next to the app. Ports: lane k uses HTTP 1908k, Tilt 1040k.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      pair: { type: "string" },
      "no-start": { type: "boolean", default: false },
      max: { type: "string" },
      port: { type: "string" },
      root: { type: "string" },
      budget: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return command ? 0 : 1;
  }

  const manager = new LaneManager({
    sourceDir: resolve(values.root ?? process.cwd()),
    driver: new RealFlisk(),
    isPortFree,
    maxLanes: values.max ? Number(values.max) : undefined,
  });

  const arena = new Arena({
    baseDir: resolve(values.root ?? process.cwd()),
    lanes: manager,
    agent: new ClaudeAgent(),
    http: (lane, request) =>
      laneRequest({ port: lane.ports.http, host: `api.${lane.projectName}.localhost`, ...request }),
    prepareLane: writeLaneTools,
    budgetUsd: values.budget ? Number(values.budget) : undefined,
  });

  switch (command) {
    case "create": {
      const [first] = args;
      const count = first && /^\d+$/.test(first) ? Number(first) : 1;
      const name = first && !/^\d+$/.test(first) ? first : undefined;
      const pair = values.pair ? parsePair(values.pair) : undefined;
      const lanes = [];
      for (let i = 0; i < count; i++) {
        const lane = await manager.create({ name, pair });
        console.log(`created ${lane.name}  (${lane.pair.a} vs ${lane.pair.b})  ${lane.dir}`);
        lanes.push(lane);
      }
      if (values["no-start"]) return 0;
      console.log(`starting ${lanes.map((l) => l.name).join(", ")} (first build takes ~2 min)...`);
      const results = await Promise.all(
        lanes.map(async (lane) => ({ lane, result: await manager.start(lane.name) })),
      );
      let failed = 0;
      for (const { lane, result } of results) {
        if (result.ok) console.log(`✓ ${lane.name} ready: http://api.${lane.projectName}.localhost:${lane.ports.http}/api/vote/`);
        else {
          failed++;
          console.log(`✗ ${lane.name} failed:\n  ${result.failures.map((f) => `${f.name}: ${f.message}`).join("\n  ")}`);
        }
      }
      return failed ? 1 : 0;
    }
    case "ls": {
      const lanes = await manager.snapshot();
      if (lanes.length === 0) console.log("No lanes. Create one: bun run lanes create");
      for (const lane of lanes) {
        const health = lane.services
          .filter((s) => s.status !== "unknown")
          .map((s) => `${s.name}:${s.status}`)
          .join(" ");
        console.log(`${lane.name.padEnd(8)} ${(lane.activity ?? lane.state).padEnd(9)} ${lane.pair.a} vs ${lane.pair.b}`);
        console.log(`         vote ${lane.urls.vote}\n         result ${lane.urls.result}   tilt ${lane.urls.tilt}`);
        if (health) console.log(`         ${health}`);
      }
      return 0;
    }
    case "up": {
      const result = await manager.start(required(args[0], "lane name"));
      console.log(result.ok ? "✓ ready" : `✗ ${result.failures.map((f) => `${f.name}: ${f.message}`).join("\n  ")}`);
      return result.ok ? 0 : 1;
    }
    case "down":
      await manager.stop(required(args[0], "lane name"));
      console.log("stopped");
      return 0;
    case "rm":
      await manager.destroy(required(args[0], "lane name"));
      console.log("removed");
      return 0;
    case "votes": {
      const name = required(args[0], "lane name");
      const count = args[1] ? Number(args[1]) : 10;
      const choice = args[2] === "b" ? "b" : "a";
      const result = await manager.castVotes(name, count, choice);
      await Bun.sleep(1500);
      const counts = await manager.voteCounts(name);
      console.log(`sent ${result.sent}, accepted ${result.accepted}; ${name} now has a=${counts.a} b=${counts.b}`);
      return result.accepted === result.sent ? 0 : 1;
    }
    case "arena": {
      const [target, ...rest] = args;
      if (!target || target === "tasks") {
        for (const task of ARENA_TASKS) console.log(`${task.id.padEnd(14)} ${task.difficulty.padEnd(9)} ${task.title}\n${" ".repeat(25)}${task.summary}`);
        return 0;
      }
      if (target === "prove") {
        const taskId = required(rest[0], "task id (bun run lanes arena tasks)");
        console.log(`proving ${taskId} on an untouched control lane (no agents)...`);
        const baseline = await arena.prove(taskId);
        if (baseline.error) console.log(`✗ control lane did not start: ${baseline.error.split("\n")[0]}`);
        for (const check of baseline.checks ?? []) {
          console.log(`  ${check.passed ? "✓" : "✗"} ${check.label}${check.passed ? "" : `: ${check.detail}`}`);
        }
        console.log(`\nOriginal code: ${baseline.passed}/${baseline.total} checks. ${baseline.passed < baseline.total ? "The task is valid: its checks fail without the change." : "The original code already passes: this task proves nothing."}`);
        return 0;
      }
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new LaneError("INVALID_REQUEST", "Lane Arena runs agents with `claude --bare`, which needs ANTHROPIC_API_KEY");
      }
      const preset = ARENA_TASKS.find((task) => task.id === target);
      const { run, finished } = arena.start(preset ? { taskId: target } : { freeText: [target, ...rest].join(" ") });
      console.log(`race ${run.id}: ${run.task.title}${run.task.unverified ? " (unverified)" : ""}`);
      const seen = new Map<string, string>();
      const timer = setInterval(() => {
        for (const c of run.contestants) {
          const now = c.status ?? c.stage;
          if (seen.get(c.model) !== now) {
            seen.set(c.model, now);
            console.log(`  ${c.model.padEnd(7)} ${now}`);
          }
        }
      }, 1000);
      const done = await finished;
      clearInterval(timer);
      printLeaderboard(done);
      return done.contestants.some((c) => c.status === "passed" || c.status === "unverified") ? 0 : 1;
    }
    case "dash": {
      const dashboard = startDashboard({ lanes: manager, arena, port: values.port ? Number(values.port) : 7357, pollMs: 4000 });
      console.log(`Agent Lanes control room: ${dashboard.url}  (Ctrl+C to quit; lanes keep running)`);
      await new Promise(() => undefined);
      return 0;
    }
    default:
      console.log(`Unknown command ${command}\n\n${HELP}`);
      return 1;
  }
}

/** Small runs cost fractions of a cent; show enough digits to tell them apart. */
function formatCost(usd: number): string {
  return usd < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function printLeaderboard(run: ArenaRun): void {
  console.log(`\nLeaderboard: ${run.task.title}`);
  if (run.baseline) {
    console.log(
      run.baseline.error
        ? `  (original code: control lane did not start)`
        : `  Original code: ${run.baseline.passed}/${run.baseline.total} checks${run.baseline.passed < run.baseline.total ? " (the checks fail without the change)" : ""}`,
    );
  }
  for (const note of run.notes ?? []) console.log(`  ! ${note}`);
  for (const c of [...run.contestants].sort((x, y) => (x.rank ?? 9) - (y.rank ?? 9))) {
    const checks = c.checks ? `${c.checks.filter((k) => k.passed).length}/${c.checks.length} checks` : "no checks";
    const cost = c.agent ? formatCost(c.agent.costUsd) : "-";
    const time = c.agent ? `${Math.round(c.agent.durationMs / 1000)}s` : "-";
    const diff = c.diff ? `+${c.diff.added}/-${c.diff.removed} in ${c.diff.files.length} files` : "";
    console.log(`  ${c.rank}. ${c.model.padEnd(7)} ${(c.status ?? "").padEnd(12)} ${checks.padEnd(11)} ${cost.padEnd(7)} ${time.padEnd(6)} ${diff}`);
    for (const k of c.checks?.filter((check) => !check.passed) ?? []) console.log(`       ✗ ${k.label}: ${k.detail}`);
    if (c.error) console.log(`       ! ${c.error.split("\n")[0]}`);
    for (const denied of c.agent?.deniedTools ?? []) console.log(`       refused: ${denied}`);
  }
  console.log(`\nPatches: .arena/runs/${run.id}/<model>.patch   Try a lane: bun run lanes ls`);
}

function parsePair(value: string) {
  const [a, b] = value.split(",").map((part) => part.trim());
  if (!a || !b) throw new LaneError("INVALID_REQUEST", `--pair needs two options, e.g. --pair "Tabs,Spaces"`);
  return { a, b };
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new LaneError("INVALID_REQUEST", `Missing ${what}. See: bun run lanes --help`);
  return value;
}

main(Bun.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof LaneError ? `✗ ${error.message}` : error);
    process.exit(1);
  },
);
