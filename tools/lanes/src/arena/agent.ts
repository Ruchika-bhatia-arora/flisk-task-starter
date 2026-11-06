/** What one contestant's coding agent did. */
export interface AgentResult {
  outcome: "finished" | "over_budget" | "error";
  /** The agent's raw machine output, kept for auditing (not shown in the dashboard). */
  raw?: string;
  /** The agent's own final message, or why it stopped. */
  summary: string;
  /** What the run really cost. `--max-budget-usd` is a soft cap: the turn that crosses it still finishes. */
  costUsd: number;
  durationMs: number;
  turns: number;
  /** Tools the agent tried that its permissions refused. */
  deniedTools: string[];
}

export interface AgentTask {
  laneDir: string;
  model: string;
  prompt: string;
  budgetUsd: number;
  timeoutMs: number;
}

/** Runs one coding agent in one lane. The real one is headless Claude Code; tests use a fake. */
export interface AgentRunner {
  run(task: AgentTask): Promise<AgentResult>;
}

/** Reads `claude -p --output-format json` (one JSON object with type "result"). */
export function parseAgentResult(output: string, exitCode: number): AgentResult {
  let data: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(output.trim());
    if (parsed && typeof parsed === "object" && parsed.type === "result") data = parsed;
  } catch {
    // Not Claude's JSON: reported as an agent error below.
  }
  if (!data) {
    return {
      outcome: "error",
      summary: output.trim() || `claude exited with code ${exitCode}`,
      costUsd: 0,
      durationMs: 0,
      turns: 0,
      deniedTools: [],
    };
  }
  const subtype = String(data.subtype ?? "");
  const errors = Array.isArray(data.errors) ? data.errors.map(String) : [];
  const outcome: AgentResult["outcome"] =
    subtype === "error_max_budget_usd" ? "over_budget" : data.is_error || subtype !== "success" ? "error" : "finished";
  const denials = Array.isArray(data.permission_denials) ? data.permission_denials : [];
  return {
    outcome,
    summary: typeof data.result === "string" && data.result ? data.result : errors.join("; ") || subtype,
    costUsd: Number(data.total_cost_usd ?? 0),
    durationMs: Number(data.duration_ms ?? 0),
    turns: Number(data.num_turns ?? 0),
    deniedTools: denials.map((denial: { tool_name?: string; tool_input?: { command?: unknown } }) => {
      const tool = String(denial?.tool_name ?? "unknown");
      const command = denial?.tool_input?.command;
      return typeof command === "string" ? `${tool}: ${command}` : tool;
    }),
  };
}

/** Tools an Arena agent may use: file tools inside its lane, and two scripts that only reach its own lane. */
export const ARENA_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(./.arena-tools/lane-curl *)",
  "Bash(./.arena-tools/lane-status)",
];

/**
 * Headless Claude Code in the lane folder. `--bare` matters: without it the user's global CLAUDE.md is loaded
 * (rules such as "create a branch first" or "ask for a ticket number"), which an unattended agent cannot follow.
 * `dontAsk` refuses every tool not in the allowlist instead of waiting for an answer nobody gives.
 */
export class ClaudeAgent implements AgentRunner {
  constructor(private readonly claudeBin = process.env.LANES_CLAUDE_BIN ?? "claude") {}

  async run(task: AgentTask): Promise<AgentResult> {
    const proc = Bun.spawn(
      [
        this.claudeBin,
        "-p",
        task.prompt,
        "--bare",
        "--model",
        task.model,
        "--output-format",
        "json",
        "--max-budget-usd",
        String(task.budgetUsd),
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        ...ARENA_ALLOWED_TOOLS,
      ],
      { cwd: task.laneDir, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const timer = setTimeout(() => proc.kill(), task.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (proc.signalCode) {
      return {
        outcome: "error",
        summary: `stopped after ${Math.round(task.timeoutMs / 60_000)} min without finishing`,
        costUsd: 0,
        durationMs: task.timeoutMs,
        turns: 0,
        deniedTools: [],
      };
    }
    return { ...parseAgentResult(stdout || stderr, exitCode), raw: stdout || stderr };
  }
}
