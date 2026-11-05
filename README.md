# Flisk task starter

A small multi-service app for the Flisk Sales Architect task: a Python voting
front end, a Node.js results page, a .NET worker, Redis and Postgres, started
today with `docker compose up`.

Your job (Part 1 of the task): make it start with one `flisk up`.

1. Press **Fork** on GitHub to create your own public copy. Do not open
   issues or pull requests here.
2. In your copy, run `npx @flisk-sh/flisk import . --dry-run`, then the same
   without `--dry-run`, then `flisk up`. You need Docker running.

   **On Windows:** this app runs as containers, so `flisk up` needs Ubuntu on
   WSL2, not PowerShell. Do every step inside Ubuntu: clone your fork into the
   Ubuntu home folder (`~/`, not `/mnt/c` or `D:\`), turn on Docker Desktop's
   WSL integration for Ubuntu, and install Node.js 22.12+ and Tilt in Ubuntu.
   Guide: https://github.com/flisk-sh/flisk/blob/main/docs/start-here-on-windows.md
3. Replace this README with yours: how to start it with `flisk up`, and what
   was hard.

The full task, the rules and the self-check are on the task page you were sent.

Licence: Apache 2.0, see LICENSE and NOTICE. Keep both files in your copy.
