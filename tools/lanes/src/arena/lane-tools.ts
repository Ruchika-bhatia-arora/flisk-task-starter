import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLISK_VERSION } from "../flisk";
import type { LaneRecord } from "../manager";

/**
 * Writes the only two commands an Arena agent may run (see ARENA_ALLOWED_TOOLS):
 *  - lane-curl <path> [-d <form>]: an HTTP request to THIS lane's Traefik, nothing else. Arguments are fixed in
 *    shape so extra URLs or curl options (which could reach other hosts or write files) are refused.
 *  - lane-status: `flisk status --json` for this lane.
 */
export function writeLaneTools(lane: LaneRecord): void {
  const dir = join(lane.dir, ".arena-tools");
  mkdirSync(dir, { recursive: true });
  const host = `api.${lane.projectName}.localhost`;
  const base = `http://127.0.0.1:${lane.ports.http}`;
  const curl = `#!/bin/sh
# Agent Lanes: reach only this lane's live app (${lane.projectName}).
# Usage: ./.arena-tools/lane-curl /api/vote/            (GET)
#        ./.arena-tools/lane-curl /api/vote/ -d vote=a  (POST form)
set -eu
usage() { echo "usage: lane-curl /path [-d form-data]" >&2; exit 2; }
path="\${1:-}"
case "$path" in /*) ;; *) usage ;; esac
case "$path" in *[[:space:]]*) usage ;; esac
if [ "$#" -eq 1 ]; then
  exec curl -sS -i -m 20 -H "Host: ${host}" "${base}$path"
elif [ "$#" -eq 3 ] && [ "$2" = "-d" ]; then
  exec curl -sS -i -m 20 -H "Host: ${host}" --data-raw "$3" "${base}$path"
fi
usage
`;
  const status = `#!/bin/sh
# Agent Lanes: Flisk's view of this lane's services.
export PATH="$HOME/.docker/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
exec npx -y @flisk-sh/flisk@${FLISK_VERSION} status --json
`;
  writeFileSync(join(dir, "lane-curl"), curl);
  writeFileSync(join(dir, "lane-status"), status);
  chmodSync(join(dir, "lane-curl"), 0o755);
  chmodSync(join(dir, "lane-status"), 0o755);
}
