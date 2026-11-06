# Voting app on Flisk, plus Agent Lanes

This is a small voting app with five parts: a Python vote page, a Node.js results page, a .NET worker, Redis and Postgres. Flisk starts all of it with one command, `flisk up`.

On top of the app there are two tools. Agent Lanes runs several separate copies of the app side by side, which is what you need when several AI coding agents work on one app. Lane Arena gives the same change to three Claude models (Haiku, Sonnet and Opus), lets each one work in its own copy, and checks each result against its running app.

Why we built it this way is explained in [DECISIONS.md](DECISIONS.md). Where we think Flisk should go next is in [ROADMAP.md](ROADMAP.md).

Tested with Flisk 1.4.37, Tilt 0.37.8, Docker Desktop 29.9.2 and Bun 1.4.2 on macOS.

## Run the app with Flisk

You need Node.js 22.12 or newer, Docker Desktop (running) and Tilt (`brew install tilt`).

```bash
cp .env.example .env          # the Postgres password Compose used; .env stays out of version control
npx @flisk-sh/flisk up        # first start ~2 min (builds the .NET worker), later ~15 s
npx @flisk-sh/flisk networks  # prints the URLs
```

Then open these two pages:

- Vote: <http://api.flisk-task-starter-main.localhost/api/vote/>
- Results: <http://api.flisk-task-starter-main.localhost/api/result/>

`npx @flisk-sh/flisk down` stops everything. To add 3,000 fake votes, run `npx @flisk-sh/flisk up --profile seed`.

If you just installed Docker Desktop, its command-line tool is in `~/.docker/bin`. Add that folder to your `PATH` or open a new terminal.

The Flisk setup (`.flisk/project.json` and one `service.json` per service under `services/flisk-task-starter-main/`) came from `flisk import . --yes`. We changed one thing: vote and result no longer ask for host ports 8080 and 8081, because another program on the machine was already using 8081.

## Agent Lanes

```bash
bun run lanes create 2     # two lanes, alpha (Tabs or Spaces?) and beta (Vim or Emacs?), started together
bun run lanes ls           # state, health and URLs of every lane
bun run lanes votes alpha 10 a
bun run lanes dash         # control room at http://127.0.0.1:7357
bun run lanes rm alpha     # stops it, deletes its volumes and its folder
bun run test:lanes         # 115 tests, under a second
```

Each lane is a copy of the app in `.lanes/<name>/`. It runs as its own Flisk project with its own containers, database, ports and vote question. Lane number k uses HTTP port 19080 + k.

The control room in the browser draws each lane as a track that follows the data from vote to redis, worker, db and result, with a lamp for each service's health. If you cast votes in one lane, only that lane's count goes up, and every other lane shows "Unchanged".

Do not run the main app and lanes at the same time. Flisk counts copies inside the project folder as part of the main app when it checks ports.

The code is in `tools/lanes/src/` and the tests are in `tools/lanes/test/`.

## Lane Arena

```bash
bun run lanes arena tasks           # the preset races
bun run lanes arena result-labels   # race Haiku, Sonnet and Opus on one; prints the leaderboard
bun run lanes arena prove durable-votes  # run a task's checks on the original code only (no agents, free)
bun run lanes dash                  # or start races, watch them and apply winners in the control room
```

Racing needs `ANTHROPIC_API_KEY`. Each agent can spend at most $1, or $2 on `durable-votes`.

A race goes like this:

1. Running lanes pause to free up room, and the lanes from the last race are removed.
2. Three lanes start, one for each model, all with the same vote question.
3. Each model works in its own lane. A fourth lane keeps the original code and runs the same checks with no agent, to prove the checks fail without the change.
4. When an agent finishes, the Arena waits for any rebuild, restarts the services whose code changed, and runs the task's checks against that lane's live app. The checks are real web requests and database queries.
5. The leaderboard ranks lanes by checks passed, then cost, then time. Each agent's changes are saved in `.arena/runs/<id>/`.
6. The race lanes are stopped and your own lanes start again. You can restart any race lane later to try its version.
7. "Apply to base" copies a passing agent's changes into this app. Every file it replaces is backed up to `.arena/backups/` first.

What agents may do while they work, and why they run with `--bare`, is in [DECISIONS.md](DECISIONS.md) (sections 10 and 11).

There are four preset tasks. A task you type yourself is allowed, but it has no checks, so the result is marked "unverified".

| Task | What it asks for |
|---|---|
| `vote-healthz` | A small health page on the vote app that also lists the two options. |
| `result-labels` | The results page shows the lane's own options. Before this, it always said Cats and Dogs. |
| `third-option` | A third choice, Birds, on the vote page, stored in Postgres and counted on the results side. |
| `durable-votes` | Reject any vote other than a or b, and make the worker never lose a vote or crash when Postgres goes down. A chaos test freezes the worker, queues 10 votes, stops Postgres, then brings everything back. All 10 votes must be saved. |

The original code passes 9 of the 13 `durable-votes` checks. It accepts a vote of `z`, saves 20 invalid votes, loses one of the 10 queued votes, and its worker crashes once.

## Race results

Measured on 2026-11-05 with Claude Code 2.1.318 and Flisk 1.4.37. All three models passed every check on every task, so cost decided the order every time.

| Task | Haiku | Sonnet | Opus | Race time |
|---|---|---|---|---|
| `vote-healthz` | $0.0015, 10 s | $0.0153, 7 s | $0.0482, 13 s | 2 min 9 s |
| `result-labels` | $0.0027, 14 s | $0.0332, 13 s | $0.1506, 38 s | 2 min 1 s |
| `third-option` | $0.0092, 48 s | $0.0866, 33 s | $0.3493, 89 s | 3 min 7 s |
| `durable-votes` | $0.0078, 45 s | $0.0478, 21 s | $0.3512, 113 s | 5 min 20 s |

Haiku came first in every race, at 1/20 to 1/45 of what Opus cost.

On `durable-votes`, all three fixed the worker the same way. They read the next vote without removing it from the queue, save it to Postgres, and only then remove it. If anything fails, they wait and try the same vote again. That works with one worker. With two workers, one could remove a vote the other is still saving, so a harder task would run two workers.

None of the agents tested their own work against the live app, even though they had a tool to do it. That is why the Arena runs the checks itself.

Haiku's fix for `result-labels` is now part of this app. To race that task again from the original code, first copy the backed-up files from `.arena/backups/20261105-112856/haiku/` back over `result/`.

## What was hard

1. `flisk import .` wrote nothing when there was no terminal to confirm. Adding `--yes` fixed it, but the command from the instructions fails in scripts and for agents.
2. The first `flisk up` failed after two minutes. The import had kept the results page on host port 8081, which an Expo dev server already used. Flisk's error only said that `docker compose` failed, and `flisk logs` couldn't help because Tilt had already stopped. We found the cause by running the generated `docker compose` command by hand, then removed the fixed ports.
3. `flisk doctor` reported failures right after a successful import, for files that `flisk up` creates by itself.
4. `flisk up --wait --json` printed "ok", then printed two failure messages, and still exited with success. A script that reads the last line thinks it failed.
5. `flisk status --json` said Tilt was available even after `flisk down`. Whether a stack is running has to be read from a different field (`tilt.readiness`).
6. Flisk issue #3197 shows up on this app. A request to `/api/voters` reaches the vote app, because the route for `/api/vote` also matches longer paths.
7. The import dropped the development build of the vote app, so code changes there need a rebuild of about a minute.
8. Copies of one project collide in several ways: shared names, a shared database volume, ports picked at the same moment, and shell settings that override each copy's own. [DECISIONS.md](DECISIONS.md) section 6 lists what each copy changes.
9. `flisk status` and `flisk networks` print different URLs for the same page.
10. Docker ran out of network addresses before it ran out of memory. Each Flisk copy uses 7 networks and Docker's defaults allow about 31, so a fifth copy fails with an error that only appears deep in Tilt's log. An idle copy uses about 280 MB of the 7.7 GB Docker has. Lanes now checks for room first, and races pause other lanes. A bigger address pool fixes it for good: in Docker Desktop, open Settings, then Docker Engine, and add `"default-address-pools": [{"base": "10.210.0.0/16", "size": 24}]`. We first blamed something else and the Tilt log proved us wrong.
11. When two copies started Tilt within milliseconds of each other, one could lose its entry in Tilt's shared settings file. Flisk then waited 15 minutes for a copy whose containers were all healthy. Lanes now starts Tilt for one copy at a time.
12. Without `--bare`, a headless agent loads the developer's personal Claude Code instructions, which an unattended agent cannot follow.
13. The spending cap is not exact. A test capped at $0.0001 spent $0.002, so the leaderboard shows real spend.
14. "Ready" does not mean the new code is running. The vote app needed a rebuild of about 62 seconds before an edit showed up. The Arena therefore restarts the changed services and retries its checks.
15. The results page always said Cats and Dogs, even when the vote page asked something else. Running lanes side by side made this obvious, and it became the `result-labels` task.
16. Checking the tasks on the original code caught a bug in our own tool: a helper was dropping the voter's cookie. It is fixed and has a test.

First start takes about 2 minutes, a warm `flisk up` about 14 seconds, two new lanes about 17 seconds, and a race 2 to 5 minutes.

## Licence

Apache 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
