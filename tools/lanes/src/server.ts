import { join } from "node:path";
import type { ArenaRun } from "./arena/arena";
import { ARENA_TASKS, findTask } from "./arena/tasks";
import type { UpResult } from "./driver";
import type { LaneRecord, LaneView } from "./manager";
import { LaneError } from "./plan";
import type { OptionPair } from "./transform";

/** What the dashboard needs from the lane manager. */
export interface LaneService {
  snapshot(): Promise<LaneView[]>;
  create(request: { name?: string; pair?: OptionPair; arena?: boolean }): Promise<LaneRecord>;
  start(name: string): Promise<UpResult>;
  stop(name: string): Promise<void>;
  destroy(name: string): Promise<void>;
  castVotes(name: string, count: number, choice: "a" | "b"): Promise<{ sent: number; accepted: number }>;
  voteCounts(name: string): Promise<{ a: number; b: number }>;
}

/** What the dashboard needs from Lane Arena. */
export interface ArenaService {
  start(request: { taskId?: string; freeText?: string }): { run: ArenaRun; finished: Promise<ArenaRun> };
  latest(): ArenaRun | null;
  isRunning(): boolean;
  patch(runId: string, model: string): string;
  apply(runId: string, model: string): Promise<string[]>;
  startLane(model: string): Promise<UpResult>;
}

export interface DashboardOptions {
  lanes: LaneService;
  arena?: ArenaService;
  port?: number;
  /** How often the live stream asks Flisk for every lane's state. */
  pollMs?: number;
  /** Wait after casting votes before counting: the worker moves them from Redis to Postgres in ~100 ms batches. */
  voteSettleMs?: number;
}

export interface Dashboard {
  url: string;
  stop(): void;
}

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

/** Server-sent events: one "lanes" event now, then one per poll, until the browser goes away. */
function eventStream(lanes: LaneService, arena: ArenaService | undefined, pollMs: number): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        if (closed) return;
        try {
          const payload = JSON.stringify({
            lanes: await lanes.snapshot(),
            arena: arena?.latest() ?? null,
            at: new Date().toISOString(),
          });
          if (!closed) controller.enqueue(encoder.encode(`event: lanes\ndata: ${payload}\n\n`));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!closed) controller.enqueue(encoder.encode(`event: problem\ndata: ${JSON.stringify({ message })}\n\n`));
        }
        if (!closed) timer = setTimeout(push, pollMs);
      };
      await push();
    },
    cancel() {
      closed = true;
      clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

export function startDashboard(options: DashboardOptions): Dashboard {
  const { lanes } = options;
  const pollMs = options.pollMs ?? 3000;
  const voteSettleMs = options.voteSettleMs ?? 1500;

  /** Long operations (flisk up/down) run after the response; their outcome shows up in the live state. */
  const inBackground = (work: Promise<unknown>) => work.catch(() => undefined);
  const accepted = (work: Promise<unknown>) => {
    inBackground(work);
    return Response.json({ accepted: true }, { status: 202 });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 7357,
    idleTimeout: 0,
    routes: {
      "/": () => new Response(Bun.file(join(PUBLIC_DIR, "index.html"))),
      "/api/lanes": {
        GET: async () => Response.json({ lanes: await lanes.snapshot() }),
        POST: async (req) => {
          const body = await readJson(req);
          const lane = await lanes.create({ name: body.name || undefined, pair: body.pair });
          if (body.start !== false) inBackground(lanes.start(lane.name));
          return Response.json({ lane }, { status: 201 });
        },
      },
      "/api/lanes/:name": {
        DELETE: (req) => accepted(lanes.destroy(req.params.name)),
      },
      "/api/lanes/:name/start": { POST: (req) => accepted(lanes.start(req.params.name)) },
      "/api/lanes/:name/stop": { POST: (req) => accepted(lanes.stop(req.params.name)) },
      "/api/lanes/:name/votes": {
        POST: async (req) => {
          const body = await readJson(req);
          const count = Number(body.count);
          if (!Number.isInteger(count) || count < 1 || count > 100 || (body.choice !== "a" && body.choice !== "b")) {
            throw new LaneError("INVALID_REQUEST", "Send {count: 1-100, choice: \"a\" | \"b\"}");
          }
          const result = await lanes.castVotes(req.params.name, count, body.choice);
          await Bun.sleep(voteSettleMs);
          return Response.json({ ...result, counts: await lanes.voteCounts(req.params.name) });
        },
      },
      "/api/lanes/:name/counts": {
        GET: async (req) => Response.json({ counts: await lanes.voteCounts(req.params.name) }),
      },
      "/api/events": () => eventStream(lanes, options.arena, pollMs),
      "/api/arena/tasks": () =>
        Response.json({
          tasks: ARENA_TASKS.map((task) => ({
            id: task.id,
            title: task.title,
            difficulty: task.difficulty,
            summary: task.summary,
            checks: task.checks.map((check) => check.label),
          })),
        }),
      "/api/arena/runs": {
        POST: async (req) => {
          const arena = requireArena(options.arena);
          const body = await readJson(req);
          const taskId = typeof body.taskId === "string" ? body.taskId : undefined;
          const freeText = typeof body.freeText === "string" ? body.freeText.trim() : "";
          if (taskId ? !findTask(taskId) : !freeText) {
            throw new LaneError("INVALID_REQUEST", "Send {taskId} of a preset race, or {freeText} for an unverified one");
          }
          if (arena.isRunning()) throw new LaneError("RACE_RUNNING", "A race is already running; wait for it to finish");
          const { run, finished } = arena.start(taskId ? { taskId } : { freeText });
          inBackground(finished);
          return Response.json({ run }, { status: 202 });
        },
      },
      "/api/arena/lanes/:model/start": {
        POST: (req) => accepted(requireArena(options.arena).startLane(req.params.model)),
      },
      "/api/arena/runs/latest": () => Response.json({ run: options.arena?.latest() ?? null }),
      "/api/arena/runs/:id/patch/:model": (req) =>
        new Response(requireArena(options.arena).patch(req.params.id, req.params.model), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      "/api/arena/runs/:id/apply/:model": {
        POST: async (req) => {
          try {
            return Response.json({ written: await requireArena(options.arena).apply(req.params.id, req.params.model) });
          } catch (error) {
            if (error instanceof LaneError) throw error;
            throw new LaneError("NOT_APPLIED", error instanceof Error ? error.message : String(error));
          }
        },
      },
    },
    fetch: () => Response.json({ error: { code: "NOT_FOUND", message: "No such route" } }, { status: 404 }),
    error: (error) => errorResponse(error),
  });

  return { url: server.url.toString(), stop: () => server.stop(true) };
}

// biome-ignore lint/suspicious/noExplicitAny: request bodies are small, validated where used.
async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_NAME: 400,
  INVALID_REQUEST: 400,
  NAME_TAKEN: 409,
  LANE_CAP: 409,
  UNKNOWN_LANE: 404,
  RACE_RUNNING: 409,
  NOT_APPLIED: 409,
  NO_ARENA: 404,
};

function requireArena(arena: ArenaService | undefined): ArenaService {
  if (!arena) throw new LaneError("NO_ARENA", "Lane Arena is not enabled in this dashboard");
  return arena;
}

function errorResponse(error: unknown): Response {
  if (error instanceof LaneError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: STATUS_BY_CODE[error.code] ?? 500 },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: { code: "INTERNAL", message } }, { status: 500 });
}
