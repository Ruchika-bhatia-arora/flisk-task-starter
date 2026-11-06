import type { Check } from "./checks";

export interface ArenaTask {
  id: string;
  title: string;
  difficulty: "warm-up" | "real bug" | "hard" | "hardest";
  /** Per-agent spending cap for this task, when it needs more room than the default. */
  budgetUsd?: number;
  /** One line for the dashboard. */
  summary: string;
  /** What the agent is asked to do. The checks are appended as its acceptance criteria. */
  request: string;
  checks: Check[];
}

/**
 * Preset races. `{A}` and `{B}` are the lane's options (OPTION_A / OPTION_B, given to both vote and result).
 * Paths are on the lane's Traefik host: /api/vote/... reaches the vote app at /..., /api/result/... the results app.
 */
export const ARENA_TASKS: ArenaTask[] = [
  {
    id: "result-labels",
    title: "Results page shows this lane's options",
    difficulty: "real bug",
    summary: "The results page hard-codes Cats and Dogs while the vote page asks the lane's own question.",
    request: [
      "The results page (result/views/index.html, result/views/app.js, result/server.js) always shows the labels",
      '"Cats" and "Dogs", even though the vote page shows the options from the OPTION_A and OPTION_B environment',
      "variables, which the results service also receives. Make the results page show the same two options:",
      'add GET /options to the results server returning JSON {"a": OPTION_A, "b": OPTION_B} (defaults "Cats" and',
      '"Dogs" when unset), and make the page take its labels from it instead of hard-coding them.',
    ].join(" "),
    checks: [
      {
        id: "options",
        label: "GET /api/result/options answers with this lane's options",
        kind: "http",
        method: "GET",
        path: "/api/result/options",
        expect: { status: 200, json: { a: "{A}", b: "{B}" } },
      },
      {
        id: "no-hardcoded",
        label: "The results page no longer hard-codes Cats or Dogs",
        kind: "http",
        method: "GET",
        path: "/api/result/",
        expect: { status: 200, notContains: [">Cats<", ">Dogs<"] },
      },
    ],
  },
  {
    id: "vote-healthz",
    title: "Health endpoint on the vote app",
    difficulty: "warm-up",
    summary: "A small, single-file change: a JSON health endpoint that also reports the options.",
    request: [
      "Add GET /healthz to the vote app (vote/app.py) returning JSON",
      '{"status": "ok", "options": [OPTION_A, OPTION_B]} with the two options the app already reads.',
    ].join(" "),
    checks: [
      {
        id: "healthz",
        label: "GET /api/vote/healthz answers ok with this lane's options",
        kind: "http",
        method: "GET",
        path: "/api/vote/healthz",
        expect: { status: 200, json: { status: "ok", options: ["{A}", "{B}"] } },
      },
      {
        id: "page",
        label: "The vote page still works",
        kind: "http",
        method: "GET",
        path: "/api/vote/",
        expect: { status: 200, contains: ['value="a"', 'value="b"'] },
      },
    ],
  },
  {
    id: "third-option",
    title: "A third voting option, end to end",
    difficulty: "hard",
    summary: "Crosses services: the vote page, the stored votes and the results all learn about option C.",
    request: [
      "Add a third option to the voting app. The vote page (vote/app.py, vote/templates/index.html) shows a",
      'third button with value "c", labelled from the OPTION_C environment variable (default "Birds"). Votes for c',
      "must be stored like a and b (the .NET worker moves votes from Redis to Postgres; check whether it needs a",
      'change). The results server (result/server.js) gets GET /scores returning JSON {"a": n, "b": n, "c": n}',
      "with the counts from Postgres, and the results page shows the third option.",
    ].join(" "),
    checks: [
      {
        id: "button",
        label: "The vote page has a third button for Birds",
        kind: "http",
        method: "GET",
        path: "/api/vote/",
        expect: { status: 200, contains: ['value="c"', "Birds"] },
      },
      {
        id: "vote-c",
        label: "Voting for c is accepted",
        kind: "http",
        method: "POST",
        path: "/api/vote/",
        form: "vote=c",
        expect: { status: 200 },
      },
      {
        id: "stored",
        label: "The vote for c reaches this lane's Postgres",
        kind: "db",
        sql: "select count(*) from votes where vote = 'c'",
        expect: { atLeast: 1 },
      },
      {
        id: "scores",
        label: "GET /api/result/scores reports a, b and c",
        kind: "http",
        method: "GET",
        path: "/api/result/scores",
        expect: { status: 200, jsonKeys: ["a", "b", "c"] },
      },
    ],
  },
  {
    id: "durable-votes",
    title: "No vote lost, none invented",
    difficulty: "hardest",
    budgetUsd: 2,
    summary: "Real data-loss bug: the .NET worker drops votes when Postgres goes away, and the vote app stores anything.",
    request: [
      "Make the voting pipeline trustworthy. (1) The vote app (vote/app.py) accepts only the choices a and b; any",
      "other value is answered with HTTP 400 and never queued. (2) A voter who changes their vote keeps exactly one",
      "stored vote, the latest. (3) The .NET worker (worker/Program.cs) must never lose a vote and never exit when",
      "Postgres is unavailable: today it pops a vote from Redis before it knows it can store it, so a vote taken",
      "while Postgres is down is dropped, and a database error ends the process. Votes must wait (stay in Redis or be",
      "retried) and be stored once Postgres is back. The worker is compiled .NET: after you edit it, its image is",
      "rebuilt automatically before the checks run. Keep the changes focused; do not rewrite the services.",
    ].join(" "),
    checks: [
      {
        id: "reject",
        label: "POST vote=z is refused with HTTP 400",
        kind: "http",
        method: "POST",
        path: "/api/vote/",
        form: "vote=z",
        expect: { status: 400 },
      },
      {
        id: "none-invented",
        label: "Postgres holds no vote other than a or b",
        kind: "db",
        sql: "select count(*) from votes where vote not in ('a', 'b')",
        withinMs: 10_000,
        expect: { equals: 0 },
      },
      {
        id: "change-a",
        label: "Voter arena-same votes a",
        kind: "http",
        method: "POST",
        path: "/api/vote/",
        form: "vote=a",
        headers: { Cookie: "voter_id=arena-same" },
        expect: { status: 200 },
      },
      {
        id: "change-b",
        label: "…then changes to b",
        kind: "http",
        method: "POST",
        path: "/api/vote/",
        form: "vote=b",
        headers: { Cookie: "voter_id=arena-same" },
        expect: { status: 200 },
      },
      {
        id: "one-vote",
        label: "Voter arena-same has exactly one stored vote, b",
        kind: "db",
        sql: "select string_agg(vote, ',') from votes where id = 'arena-same'",
        expect: { equals: "b" },
      },
      {
        id: "freeze-worker",
        label: "Chaos: the worker is frozen, as if busy elsewhere",
        kind: "action",
        do: "pause",
        service: "worker",
      },
      {
        id: "queue-votes",
        label: "10 voters (arena-d1..10) vote; their votes wait in Redis",
        kind: "http",
        method: "POST",
        path: "/api/vote/",
        form: "vote=a",
        headers: { Cookie: "voter_id=arena-d{i}" },
        repeat: 10,
        withinMs: 10_000,
        expect: { status: 200 },
      },
      { id: "db-down", label: "Postgres is stopped while those votes are queued", kind: "action", do: "stop", service: "db" },
      { id: "thaw-worker", label: "The worker resumes and meets a dead database", kind: "action", do: "unpause", service: "worker" },
      { id: "down-a-while", label: "Postgres stays down for 8 s", kind: "wait", seconds: 8 },
      { id: "db-up", label: "Postgres is started again", kind: "action", do: "start", service: "db" },
      {
        id: "all-stored",
        label: "All 10 queued votes are stored once Postgres is back",
        kind: "db",
        sql: "select count(*) from votes where id like 'arena-d%'",
        withinMs: 90_000,
        expect: { equals: 10 },
      },
      {
        id: "worker-steady",
        label: "The worker never crashed (0 container restarts during the checks)",
        kind: "restarts",
        service: "worker",
        expect: { atMost: 0 },
      },
    ],
  },
];

export function findTask(id: string): ArenaTask | undefined {
  return ARENA_TASKS.find((task) => task.id === id);
}
