# CATCH-UP — Bring a machine fully current in one command

Run **`catch-up`** before starting a Claude Code session on any fresh or
stale machine. It clones every missing repo from your registry, pulls the
latest on everything already cloned, and installs per-repo dependencies
(`npm ci` / `pip install -e ".[dev]"`) whose lockfiles have changed since
the last sync.

## Quick start

```bash
catch-up                       # all configured orgs, full sync
catch-up --dry-run             # preview only — no network writes
catch-up --org sffoundry       # limit scope to one org
catch-up --skip-deps           # git only, no npm/pip
catch-up --skip-pull           # still clones missing, skips pull on existing
catch-up --json                # machine-readable output
```

`catch-up` is a thin shell shim that calls `aiw machine sync`. Anything the
shim accepts, `aiw machine sync` accepts.

## First-time install on a new machine

```bash
# 1. Clone sffoundry/ai-workflows (or your org's master ai-workflows).
git clone git@github.com:sffoundry/ai-workflows.git ~/sffoundry/ai-workflows

# 2. Install the aiw CLI in editable mode.
pip install --user --break-system-packages -e ~/sffoundry/ai-workflows/tools/aiw

# 3. Put the shim on PATH.
mkdir -p ~/bin
# (Copy ~/CATCH-UP.md's sibling shim from any sffoundry checkout, or run:)
cat > ~/bin/catch-up <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
if ! command -v aiw >/dev/null 2>&1; then
  echo "ERROR: aiw CLI not found. Install with:" >&2
  echo "  pip install --user --break-system-packages -e ~/sffoundry/ai-workflows/tools/aiw" >&2
  exit 127
fi
{
  echo "============================================"
  echo "  catch-up — bringing this machine current"
  echo "  $(date '+%Y-%m-%d %H:%M')"
  echo "============================================"
  echo ""
} >&2
exec aiw machine sync "$@"
SHIM
chmod +x ~/bin/catch-up

# 4. Ensure ~/bin and ~/.local/bin are on PATH (in ~/.bashrc or ~/.zshrc):
#    export PATH="$HOME/bin:$HOME/.local/bin:$PATH"

# 5. Ensure gh CLI is authenticated (required for some aiw commands):
#    gh auth status
#    gh auth login         # if not already

# 6. Catch up for the first time.
catch-up
```

Prereqs NOT installed by catch-up (install them yourself if missing):
`git`, `gh`, `python3.11+`, `pip`, `node`/`npm` (for JS repos),
`pip`/`uv` (for Python repos).

## What `catch-up` does (in order)

1. **Prereq check** — fails fast if `git` or `gh` isn't on PATH.
2. **Registry union** — reads `scripts/repos.sh` in every configured
   org's `ai-workflows/` (per DEC-002). Produces the canonical list of
   every repo your machine should have.
3. **Parallel per-repo sync** (up to 6 at once):
   - Repo missing on disk → `git clone` via SSH.
   - Repo present → `git pull --ff-only`.
   - Skip with warning (never block) on: uncommitted changes, detached
     HEAD, pull failures.
4. **Dep install** (unless `--skip-deps`):
   - Detects `package.json` → `npm ci` (or `npm install` if no lockfile).
   - Detects `pyproject.toml` → `pip install -e ".[dev]"`.
   - Scans repo root plus `backend/`, `web/`, `api/`, `frontend/`,
     `server/`, `client/`.
   - Caches SHA256 of lockfiles in `<repo>/.aiw/last-sync.json`.
     Unchanged lockfile → skip reinstall. This is what makes reruns
     fast (~seconds, not minutes).
5. **Summary** — one-page report: cloned / pulled / up-to-date /
   skipped / errors, with per-repo detail.

## When to run it

- **Every time** you sit down at a machine you haven't used recently.
- **Before starting a Claude Code session** — so the workspace is sane
  before the agent acts on it.
- After `git pull` on an `ai-workflows` repo, if protocol or registry
  changes landed (the registry might have new repos to clone).
- Any time you notice "wait, why isn't X cloned?" Run `catch-up` instead
  of manually cloning — it will tell you what else is missing too.

## Exit codes

- **0** — success (may include soft skips like uncommitted-changes).
- **1** — at least one repo errored (clone/pull failure after normal
  retries).
- **2** — missing prereq (`git` or `gh` not found on PATH).

## Safety & scope

- **Never blocks on local state.** Uncommitted changes, detached HEAD,
  and pull failures all → skip + warn. The command always finishes so
  you can actually start working.
- **Read-only for cross-org files other than the registry.** Per
  DEC-002, this command is the sole named exception to the session-
  isolation rule, and the exception is narrow: registry + config files
  only. No coordination state, no research, no claims read across orgs.
- **No system-dep bootstrap.** Catch-up will fail fast if a required
  tool is missing — it will not install `node`, `python`, or `docker`
  for you. That's intentional.

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| `aiw: command not found` | Run the install in the "First-time install" section. Make sure `~/.local/bin` is on PATH. |
| `Permission denied (publickey)` | `ssh -T git@github.com` to test. Add your SSH key via `gh ssh-key add`. |
| `gh: command not found` | Install from <https://cli.github.com>. Then `gh auth login`. |
| "uncommitted local changes — skipped" | Expected — commit or stash your work, then rerun. Catch-up deliberately won't touch dirty trees. |
| `npm ci` fails with "lock file version" | Your node version differs from what generated the lockfile. Install the right node (nvm recommended). |
| Takes forever on every run | Check that `.aiw/last-sync.json` exists in repos after the first run. If missing, dep installs aren't caching — check file permissions. |

## Related

- **`aiw session start`** — session-level pre-flight (claims, drift,
  research, messages). Run AFTER catch-up.
- **DEC-002** — governance record for the cross-org isolation exception.
  In sffoundry: `decisions/DEC-002.md`.
- **`aiw machine sync --help`** — flag-level reference.

## Questions?

Edit this file and PR — it lives in the home directory and in every
sffoundry repo root so changes propagate by copy. Canonical version is
in `sffoundry/ai-workflows` (ultimately generated from that repo's
`tools/aiw/src/aiw/commands/machine.py` and related docs).
