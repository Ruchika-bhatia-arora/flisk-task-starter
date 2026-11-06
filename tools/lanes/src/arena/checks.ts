/**
 * Acceptance checks run against a contestant's LIVE lane. They are data (spec-as-code): the same list is shown to
 * every agent as its acceptance criteria and then run by the Arena. `{A}`, `{B}`, `{C}` stand for the lane's options;
 * `{i}` is the repetition number (1..n) of a repeated request.
 */
export type Check = HttpCheck | DbCheck | ActionCheck | WaitCheck | RestartsCheck;

interface CheckBase {
  id: string;
  label: string;
  /** How long this check may be retried while it fails (a service may still be restarting). */
  withinMs?: number;
}

export interface HttpCheck extends CheckBase {
  kind: "http";
  method: "GET" | "POST";
  /** Path on the lane's Traefik host, e.g. /api/result/options */
  path: string;
  /** URL-encoded form body for POST. */
  form?: string;
  /** Extra request headers, e.g. { Cookie: "voter_id=arena-d{i}" }. */
  headers?: Record<string, string>;
  /** Send the request this many times (i = 1..n); every answer must meet the expectation. */
  repeat?: number;
  expect: {
    status?: number;
    contains?: string[];
    notContains?: string[];
    /** Every key must be present with exactly this value (after placeholder substitution). */
    json?: Record<string, unknown>;
    /** Keys that must be present in a JSON object answer, with any value. */
    jsonKeys?: string[];
  };
}

export interface DbCheck extends CheckBase {
  kind: "db";
  /** Run with psql -tA in the lane's Postgres; the answer's first value is compared. */
  sql: string;
  expect: { atLeast?: number; atMost?: number; equals?: number | string };
}

export type ContainerVerb = "stop" | "start" | "pause" | "unpause";

/** Stops, starts, freezes or unfreezes one of the lane's containers. Runs once: an action is never retried. */
export interface ActionCheck extends CheckBase {
  kind: "action";
  do: ContainerVerb;
  service: string;
}

/** Lets time pass (for example while a database is down). */
export interface WaitCheck extends CheckBase {
  kind: "wait";
  seconds: number;
}

/** How often a service's container restarted since the checks began (a crash that Docker papered over). */
export interface RestartsCheck extends CheckBase {
  kind: "restarts";
  service: string;
  expect: { atMost: number };
}

export interface CheckResult {
  id: string;
  label: string;
  passed: boolean;
  /** "ok", or why it failed, in words a person can act on. */
  detail: string;
  attempts: number;
}

export interface CheckIO {
  http(request: {
    method: "GET" | "POST";
    path: string;
    form?: string;
    headers?: Record<string, string>;
  }): Promise<{ status: number; body: string }>;
  sql(query: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  action(verb: ContainerVerb, service: string): Promise<void>;
  restartCount(service: string): Promise<number>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CheckTiming {
  /** Default retry window per check (a check's own `withinMs` wins). */
  deadlineMs?: number;
  retryMs?: number;
}

export async function runChecks(
  checks: Check[],
  vars: Record<string, string>,
  io: CheckIO,
  timing: CheckTiming = {},
): Promise<CheckResult[]> {
  const retryMs = timing.retryMs ?? 3_000;
  // Restarts are counted from here, so restarts from before this run do not count.
  const restartsAtStart = new Map<string, number>();
  for (const check of checks) {
    if (check.kind === "restarts" && !restartsAtStart.has(check.service)) {
      restartsAtStart.set(check.service, await io.restartCount(check.service).catch(() => 0));
    }
  }
  const results: CheckResult[] = [];
  for (const check of checks) {
    const deadline = io.now() + (check.withinMs ?? timing.deadlineMs ?? 60_000);
    const retriable = check.kind !== "action" && check.kind !== "wait";
    let attempts = 0;
    let failure: string | null;
    for (;;) {
      attempts++;
      failure = await attempt(check, vars, io, restartsAtStart);
      if (failure === null || !retriable || io.now() + retryMs > deadline) break;
      await io.sleep(retryMs);
    }
    results.push({ id: check.id, label: check.label, passed: failure === null, detail: failure ?? "ok", attempts });
  }
  return results;
}

/** Runs a check once. Resolves null when it passed, otherwise the reason. */
async function attempt(
  check: Check,
  vars: Record<string, string>,
  io: CheckIO,
  restartsAtStart: Map<string, number>,
): Promise<string | null> {
  switch (check.kind) {
    case "wait":
      await io.sleep(check.seconds * 1000);
      return null;
    case "action":
      try {
        await io.action(check.do, check.service);
        return null;
      } catch (error) {
        return `${check.do} ${check.service} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    case "restarts": {
      const now = await io.restartCount(check.service).catch(() => 0);
      const during = now - (restartsAtStart.get(check.service) ?? 0);
      return during <= check.expect.atMost
        ? null
        : `${check.service} restarted ${during} time(s) during the checks (at most ${check.expect.atMost} allowed)`;
    }
    case "db":
      return dbAttempt(check, io);
    case "http":
      for (let i = 1; i <= (check.repeat ?? 1); i++) {
        const failure = await httpAttempt(check, { ...vars, i: String(i) }, io);
        if (failure) return check.repeat ? `request ${i} of ${check.repeat}: ${failure}` : failure;
      }
      return null;
  }
}

async function dbAttempt(check: DbCheck, io: CheckIO): Promise<string | null> {
  const answer = await io.sql(check.sql);
  if (!answer.ok) return `query failed: ${answer.stderr.trim()}`;
  const text = answer.stdout.trim().split(/\s+/)[0] ?? "";
  const found = Number(text);
  const { expect } = check;
  if (expect.equals !== undefined) {
    const same = typeof expect.equals === "number" ? found === expect.equals : text === expect.equals;
    if (!same) return `expected ${expect.equals}, found ${text || "nothing"}`;
  }
  if (expect.atLeast !== undefined && !(found >= expect.atLeast)) {
    return `expected at least ${expect.atLeast}, found ${answer.stdout.trim()}`;
  }
  if (expect.atMost !== undefined && !(found <= expect.atMost)) {
    return `expected at most ${expect.atMost}, found ${answer.stdout.trim()}`;
  }
  return null;
}

async function httpAttempt(check: HttpCheck, vars: Record<string, string>, io: CheckIO): Promise<string | null> {
  let answer: { status: number; body: string };
  try {
    const headers = check.headers
      ? Object.fromEntries(Object.entries(check.headers).map(([key, value]) => [key, fill(value, vars) as string]))
      : undefined;
    answer = await io.http({ method: check.method, path: check.path, form: fill(check.form, vars), headers });
  } catch (error) {
    return `no answer: ${error instanceof Error ? error.message : String(error)}`;
  }
  const { expect } = check;
  if (expect.status !== undefined && answer.status !== expect.status) {
    return `expected status ${expect.status}, got ${answer.status}`;
  }
  for (const text of expect.contains ?? []) {
    const wanted = fill(text, vars) as string;
    if (!answer.body.includes(wanted)) return `the answer does not contain ${JSON.stringify(wanted)}`;
  }
  for (const text of expect.notContains ?? []) {
    const unwanted = fill(text, vars) as string;
    if (answer.body.includes(unwanted)) return `the answer still contains ${JSON.stringify(unwanted)}`;
  }
  if (expect.json || expect.jsonKeys) {
    let body: unknown;
    try {
      body = JSON.parse(answer.body);
    } catch {
      return "the answer is not JSON";
    }
    if (!body || typeof body !== "object") return "the answer is not a JSON object";
    const record = body as Record<string, unknown>;
    for (const key of expect.jsonKeys ?? []) {
      if (!(key in record)) return `the JSON has no ${JSON.stringify(key)}`;
    }
    for (const [key, raw] of Object.entries(expect.json ?? {})) {
      const wanted = fillDeep(raw, vars);
      if (JSON.stringify(record[key]) !== JSON.stringify(wanted)) {
        return `expected ${JSON.stringify(key)} to be ${JSON.stringify(wanted)}, got ${JSON.stringify(record[key])}`;
      }
    }
  }
  return null;
}

function fill(text: string | undefined, vars: Record<string, string>): string | undefined {
  return text?.replace(/\{([A-Za-z])\}/g, (match, key: string) => vars[key] ?? match);
}

function fillDeep(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return fill(value, vars);
  if (Array.isArray(value)) return value.map((item) => fillDeep(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillDeep(item, vars)]));
  }
  return value;
}
