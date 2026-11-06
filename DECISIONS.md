# Product decisions

This page lists the choices we made while building Agent Lanes and Lane Arena on top of the Flisk voting app, in the order we made them. For each one it says what we picked, why, and what we passed on. The measured results are in [README.md](README.md), and the longer product argument is in [ROADMAP.md](ROADMAP.md).

## 1. Build Agent Lanes

We built a tool that runs several separate copies of the voting app on one laptop at the same time. Each copy has its own containers, database, ports and web address.

We picked this because Flisk's own code points toward AI coding agents: an MCP server with 23 tools, and open proposals such as `flisk worktree` (#3117) and a warning when several agents edit one folder (#3128). If three agents work on one app, each needs its own running copy, and today two copies of a Flisk project clash.

We also looked at three smaller ideas: a report on what `flisk import` could not translate, a checker that every printed URL really answers, and writing up the product thesis on its own. We kept the thesis and used Lanes as its proof.

## 2. Wrap Flisk instead of changing it

Lanes is a separate tool that calls the normal `flisk` commands and reads their JSON output. We did not fork or patch Flisk.

It works with the released version of Flisk, and it shows that the `flisk worktree` idea can be built today without changes inside Flisk. Changing Flisk would have been closer to the real product, but it is a large codebase and only our own build would have run it.

## 3. TypeScript on Bun, with no extra packages

Bun gives us tests, a web server and process control out of the box. The starter already had a `bun.lock`, and Flisk itself is written in TypeScript.

## 4. Copies are plain folders, and nothing touches git

Each lane is a copy of the app in `.lanes/<name>/`, and that folder is gitignored. The tool never runs git, so creating, racing or removing lanes never touches the repository's history or branches.

The Flisk proposal assumes git worktrees, which need a repository with at least one commit. Plain copies work in any folder.

## 5. A live control room in the browser

The dashboard shows each lane as a railway track. The stations follow the data (vote, redis, worker, db, result), and a lamp on each one shows that service's health. You can create, stop and remove lanes, and cast 10 votes into one lane.

The vote button is there to make isolation visible. When you vote in one lane, only that lane's count goes up, and every other lane checks its own database and shows "Unchanged".

## 6. What a copy must change to stay separate

We read Flisk's code to find what two copies would share, and each copy changes those things:

- A new project name, `<name>-lane`. Flisk builds container, network and image names from it.
- Lane names use only lowercase letters and digits. Flisk decides which containers belong to a project by name prefix, so a lane called `app-lane1` would be treated as part of a project called `app`.
- No fixed host ports. The imported app asked for ports 8080 and 8081, and Flisk has no fallback when one is busy. Each lane gets its own fixed ports instead (19080 plus the lane number for HTTP).
- No fixed volume name. The import gave the database volume a fixed name, so every copy would have shared one database.
- No copied secrets that Flisk says must not be shared between projects, such as `JWT_SECRET`.

## 7. Lane Arena: let real agents race in lanes

Once copies worked, the next question was what you can do with several live copies that you cannot do with one. Our answer: give the same task to three AI coding agents at once, each in its own copy, then check each result against its own running app.

We picked this over three other ideas: copying a lane together with its data, letting Claude Code create lanes through MCP, and a report scoring how well any repository fits Flisk.

## 8. Judge with fixed checks against the live app

Each preset task comes with checks that are real HTTP requests and database queries against the running copy. The same checks are shown to every agent as its acceptance criteria. A free-text task is allowed, but it is marked "unverified".

We chose fixed checks over an AI judge because they give the same answer every time and cost nothing to run. An AI judge could score any task, but its verdicts change from run to run.

## 9. The three contestants differ by model

Haiku, Sonnet and Opus get the same task, the same copy of the app and the same instructions. That answers a question teams really ask: which model is good enough for this kind of change, and at what cost.

## 10. Agents may edit files and check only their own copy

Agents can read and edit files inside their copy. They can also run two small scripts: one sends a request to their own copy's web address, and the other shows their copy's Flisk status. Every other command is refused.

The request script only accepts a path and optional form data, so an agent cannot point it at another address or add curl options that write files. We decided against giving agents a full shell because they run unattended.

## 11. Run agents with `--bare`

In a test run without `--bare`, the agent read the developer's personal Claude Code instructions, which say to create a branch first and ask for a ticket number. An unattended agent in a folder without git cannot follow those. With `--bare` the agent loads no personal instructions, hooks or plugins.

## 12. A spending cap per agent

Each agent is capped at $1, and the hardest task allows $2. The cap is not exact: a test capped at $0.0001 spent $0.002, because the step that crosses the cap still finishes. The leaderboard therefore shows what each agent really spent.

## 13. "Apply to base" with backups

The dashboard shows each agent's changes. A button copies a passing agent's changed files into the main app, after backing up every file it overwrites to `.arena/backups/`. Nothing changes the main app until you click it.

## 14. Make room on the machine by pausing other lanes

Docker gives every network a block of addresses, and its default settings have about 31 blocks. Each Flisk copy needs 7 networks, so only four copies fit at once, while memory was never close to the limit (an idle copy uses about 280 MB of the 7.7 GB Docker has). We found this when races failed halfway through starting.

We chose to pause running lanes during a race and start them again afterwards, rather than change Docker's settings. Lanes now also checks for free room before it starts a copy and says clearly when there is none. A larger Docker address pool is described in the README for later.

## 15. Restart what changed, then retry the checks

A copy can report "ready" while still running the old code. The vote app only picked up an edit after a rebuild of about 62 seconds, and the worker is compiled, so it always needs a rebuild. After an agent finishes, the Arena waits for those rebuilds, restarts only the services whose code changed, and retries each check for a while before it fails it.

## 16. Prove every task on the original code first

During each race, a fourth copy keeps the original code and runs the same checks with no agent. A task only counts as valid if the original code fails it. `lanes arena prove <task>` runs this step alone, with no agents and no cost.

This step caught two of our own mistakes before any money was spent. Our request helper had been dropping the cookie that identifies a voter. Our first chaos test also never lost a vote on the original code, because the worker crashed before it held one. We fixed the helper and changed the test.

## 17. A harder task built from real bugs

The first three tasks did not separate the models, so we read the code for real problems. We found that the vote app stores any value (`vote=zzz` is saved like a real vote), and that the worker can lose a vote: it takes the vote off the queue before it knows it can save it.

The `durable-votes` task asks agents to fix both. To show the vote loss every time, the check freezes the worker, queues 10 votes, stops the database, then lets the worker run again. The original code stores 9 of the 10 and passes 9 of 13 checks.

## 18. What the races showed

All three models passed every task, including `durable-votes`. With correctness tied, cost decided every race, and Haiku did each job for 1/20 to 1/45 of what Opus cost. For changes of this size, the cheapest model was enough every time.

The next step would run two copies of the worker at once. Every agent's fix for `durable-votes` is safe with one worker but not with two, and none of the current checks test that.
