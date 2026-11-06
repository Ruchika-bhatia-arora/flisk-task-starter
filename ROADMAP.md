# Where Flisk should go in the next six months

On 2026-11-05 we read Flisk's `docs/ROADMAP.md`, its CHANGELOG from 1.3.121 to 1.4.37, and its open `rfc` and high-priority issues. We also ran this voting app on Flisk 1.4.37 and built Agent Lanes and Lane Arena on top of it. Issue numbers refer to `flisk-sh/flisk`.

## Vision

Flisk becomes the local tool that developers and their coding agents rely on. One command gives every person and every agent a full, separate, working copy of the app, and Flisk says "ready" only when that is true.

## What the evidence says

The official roadmap mostly lists upkeep: a stable 1.x, a free core, Windows support, supply-chain security, docs and more maintainers. The work being shipped and proposed points somewhere more specific.

AI agents are already a main user, although the roadmap does not say so. Flisk has an MCP server with 23 tools, and `flisk run --json` gives agents exit codes and output. Open proposals include `flisk worktree` (#3117), a warning when several agents edit one folder (#3128), writing an AGENTS.md file during import (#3213), and an `agent` service type (#1256).

New users arrive with a Compose file. Recent releases added `flisk import`, `flisk up <git-url>` and optional profiles, and there are proposals to import part of a project (#3114) and to run a Compose project without rewriting it (#2240).

The first run is still fragile. The top-priority issue #3219 collects URLs that do not open, slow first starts reported as failures, routes that match the wrong paths, and "ready" being reported before every URL answers. We hit the same kind of problems on this app.

Running several projects on one machine already causes clashes over ports 80 and 443 (#2704), and each project rebuilds the same base images (#2693).

Taken together, the next Flisk user is one developer running three agents on one laptop, and each agent needs its own copy of the app.

## Next 6 months

Scores run from 1 to 10, and ICE is Impact × Confidence × Ease. The highest score is first.

| Item | Who it is for | Impact | Confidence | Ease | ICE | Number to watch |
|------|---------------|--------|------------|------|-----|-----------------|
| Ready means ready: `up` reports ready only when every printed URL answers, and a failure names the service, the cause and the next command to run. Routes stop matching longer paths. (#3211, #3210, #3209, #3197, #3203) | Every new user, and every agent reading `--json` | 8 | 9 | 7 | 504 | Share of first `flisk up` runs that reach ready |
| One machine setup: one shared router on ports 80 and 443 for all projects, fewer networks per project (7 today), and base images built once per machine (#2704, #2693) | Anyone running more than one project, especially several copies | 8 | 8 | 5 | 320 | Projects that fit on Docker's default settings (4 today) |
| `flisk worktree`: one command makes a separate copy with its own name, ports, settings and database; `list` shows its state; `rm` cleans up safely (#3117, #3128, #3213) | Developers running two or more coding agents on one app | 9 | 7 | 5 | 315 | Projects with two or more copies running in a week |
| Compose without rewriting: run an existing Compose project as it is, import part of it, and translate build targets and host ports safely (#2240, #3114) | Teams trying Flisk on a real project | 8 | 6 | 4 | 192 | Share of `import --dry-run` runs followed by a working `up` |

### Why this order

Ready means ready comes first because nothing else matters if the first run fails. Our own first `flisk up` failed. A host port copied from the Compose file was taken by another program, the error message only said that `docker compose` failed, and `flisk logs` could not help because Tilt had already stopped. Later, `up --wait` printed "ok" followed by two failure messages, and an agent cannot work with that.

We first scored the one machine setup at 245 and moved it up to 320 after running the races. With real agents running side by side, the limit turned out to be Docker's network addresses, not memory. Each project uses 7 networks, Docker's defaults allow about 31, and the fifth project fails with an error buried in Tilt's log. An idle copy uses only about 280 MB. Copies that start Tilt at the same moment can also lose track of each other. Both problems hit exactly the people `flisk worktree` is for, so confidence went up from 7 to 8 because we measured it.

`flisk worktree` has the highest impact. Agent Lanes shows it can be built today outside Flisk by renaming the project, removing fixed ports and volume names, and giving each copy its own ports. The hard part is knowing Flisk's sharp edges. For example, Flisk decides which containers belong to a project by the start of their names, so a project called `app` treats `app-lane1` as its own, and the import gives the database volume a fixed name that every copy would share. Each of these is a small fix, so a built-in version is realistic within six months.

Lane Arena shows where worktree leads. Three models each fixed this app's real results-page bug in their own running copy, and checks against the live app confirmed every fix. Haiku cost $0.0027 and Opus $0.15. No agent tested its own work, even with a tool for it. Checking agent work from outside, on a full running copy, needs exactly what Flisk already has. A `flisk worktree` with JSON status, plus the existing `flisk run` and `flisk restart`, would let any tool do this.

Compose without rewriting is the largest change, so it scores lowest on ease. Small parts of it, such as keeping the build target and not publishing Compose host ports by default, can be done along with the first-run work.

## Not now

Flisk should not build the provider system yet (epic #2220 and issues #2244 to #2249). That plan makes the runtime, database, router, cache, queue and orchestrator swappable.

Each of those slots has only one real implementation today: Docker with Tilt, Postgres and Traefik. Interfaces designed before a second implementation exists usually end up in the wrong places. The project also has two maintainers, and top-priority first-run bugs are still open, so a refactor across the engine, generators and doctor would compete with the reliability work that decides whether people adopt Flisk.

The part users actually ask for, a lighter runtime than Docker Desktop (#2703), can be handled on its own: support Podman, Colima and OrbStack through the Docker API and test them in CI.

Once `flisk worktree` and the shared setup exist, they will show which parts really need to be swappable.
