# DevPanel AI Toolkit

A Claude Code skill and helpers for creating and running DevPanel projects and environments through the DevPanel MCP server, GitHub CLI and Git. Version: [VERSION](VERSION).

Supported (Claude Code only):

- Create a project from a DevPanel catalog template (quickclone into a new private repository).
- Create a project from an existing GitHub repository, with your choice of CPU/memory tier, PHP and MySQL.
- Create an environment for a branch of an existing project (project → branch → application → activation → verification).
- Copy database and files from one environment to another — only when you ask for it.
- Inspect an existing Drupal codebase for DevPanel deployment (no `.devpanel` template is published yet; see [templates/drupal/README.md](templates/drupal/README.md)).

Every DevPanel change is an MCP plan that you approve by answering `APPROVE` or `REJECT` to the plan text Claude shows you verbatim.

Database/files of an existing site are imported manually by a person: [docs/MANUAL-DATA-IMPORT.md](docs/MANUAL-DATA-IMPORT.md).

Deferred: Codex and OpenCode installers, WordPress and generic templates, automated database/files import.

## Layout

```text
skills/devpanel-project-lifecycle/   the skill: SKILL.md, references/ (7 workflows), scripts/, assets/
templates/drupal/                    Drupal requirements manifest and evidence status (installed into the skill)
installers/install-claude-code.sh    installer (explicit scope, repeatable, protects existing files)
scripts/setup.sh                     guided setup in the required order
scripts/doctor.sh                    diagnostics
scripts/dp-mcp-helper.mjs            direct DevPanel MCP client: read-only check, PAT classic save
docs/SETUP.md                        setup guide;  docs/EVIDENCE.md  where each mapping/constraint comes from
examples/                            example requests and an execution record
tests/                               automated checks (node --test tests/*.test.mjs)
```

## Prerequisites

- Claude Code, logged in.
- Git.
- GitHub CLI `gh` (branch workflows).
- Node.js 18+ (skill helpers, PAT helper). `curl` (site checks).
- Access to a DevPanel MCP server (its URL, e.g. the hosted HTTP endpoint provided by DevPanel) and a DevPanel account with a workspace.
- A GitHub personal access token **classic** with `repo` scope, saved in DevPanel (step 6 of setup).

## Installation

```bash
git clone <this repository> dp-ai-toolkit && cd dp-ai-toolkit
git checkout v$(cat VERSION)        # pin a released version (tags follow VERSION)
installers/install-claude-code.sh --scope user
# optionally register the DevPanel MCP server if it is not configured yet:
installers/install-claude-code.sh --scope user --configure-mcp https://<devpanel-mcp-host>/mcp
```

| Option | Effect |
|---|---|
| `--scope user` | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/devpanel-project-lifecycle` |
| `--scope project [--project-dir DIR]` | `DIR/.claude/skills/devpanel-project-lifecycle` |
| `--configure-mcp URL [--mcp-scope local\|user\|project] [--mcp-name NAME]` | `claude mcp add --transport http` only if `NAME` (default `devpanel`) does not exist; an existing entry is never changed. Default MCP scope: `user` for user installs, `local` for project installs |
| `--dry-run` | show what would happen |
| `--force` | replace a modified or foreign skill directory, keeping it as `*.bak-<timestamp>` |

The installer copies the skill, records a checksum manifest (`.dp-ai-toolkit-manifest`) and install info, and refuses to overwrite files that were changed locally or that it did not install.

## Authentication and setup

Four separate credentials: Claude Code login, DevPanel MCP authentication, GitHub CLI authentication, and the GitHub PAT classic stored in DevPanel. Follow [docs/SETUP.md](docs/SETUP.md), or run the guided, resumable script:

```bash
scripts/setup.sh --scope user --mcp-url https://<devpanel-mcp-host>/mcp
```

Order: (1) Claude Code and dependencies → (2) install skill → (3) DevPanel MCP + `/mcp` sign-in → (4) `devpanel_whoami` and workspace access → (5) `gh auth login` → (6) PAT classic in DevPanel → (7) diagnostics.

PAT classic creation on GitHub is manual. To save it in DevPanel, run the helper **in your own terminal** (it has its own DevPanel MCP sign-in, reads the token with hidden input and sends it directly to `devpanel_set_git_token`):

```bash
node scripts/dp-mcp-helper.mjs set-git-token --server-url https://<devpanel-mcp-host>/mcp
```

or save it in the DevPanel UI (the tested baseline). Never paste tokens into the Claude conversation. The toolkit never copies `gh` credentials into DevPanel.

## Example requests

In Claude Code (see [examples/requests.md](examples/requests.md) for more):

- "Create a new DevPanel project from the Drupal CMS template in workspace *Agency*, repository `acme/cms-demo`."
- "Create a DevPanel project from `acme/site`, branch `main`, Drupal 11, small_2, PHP 8.3."
- "Create an environment for branch `feature/search` in project *acme-site*, branched from `develop`."
- "Copy the database and files from the `main` environment to `feature/search` in project *acme-site*."
- "Check whether `~/src/customer-site` can be deployed on DevPanel."
- "Check my DevPanel toolkit setup."

## Diagnostics and troubleshooting

```bash
scripts/doctor.sh [--repo OWNER/REPO] [--live --server-url https://<devpanel-mcp-host>/mcp]
```

| Symptom | Cause | Fix |
|---|---|---|
| Skill not used | Not installed in this scope, or session predates install | `doctor.sh`; start a new Claude Code session |
| DevPanel tools missing / "Needs authentication" | MCP not configured or not signed in | `--configure-mcp`, then `/mcp` in Claude Code |
| `CreateRepo Not Found` | No GitHub username saved in DevPanel | Save the PAT classic + username (setup step 6) |
| `Bad credentials` | PAT in DevPanel expired or revoked | Create a new PAT classic and save it |
| Private repository or branches invisible in DevPanel | PAT lacks `repo` scope or SSO authorization | Fix the token on GitHub, save again |
| `gh` 401/403/404 | GitHub CLI not authenticated or no access | `gh auth login`; independent of DevPanel |
| `PLAN_EXPIRED` / `PLAN_STALE` | Plan older than its TTL (15 min tested) or target changed | Claude re-reads state and asks you to approve a new plan |
| Job `SUCCESS` but HTTP 500 | Application error after deploy/copy | Claude reads activity and HTTP logs; see the report |
| Branch missing from branch sync plan | DevPanel considers only the first 50 GitHub branches | Report; the branch environment cannot be created this way |
| `Real CREATE is disabled` | DevPanel MCP server configuration | Contact the MCP operator |
| Helper: "Refusing to run set-git-token inside a Claude Code session" | Started from Claude's shell | Run it in a separate terminal |

## Update

```bash
cd dp-ai-toolkit && git fetch --tags && git checkout v<new version>
installers/install-claude-code.sh --scope user      # updates an unmodified install in place
```

Locally modified skill files block the update; keep your changes elsewhere or re-run with `--force` (the old directory is kept as a backup).

## Uninstall

```bash
installers/install-claude-code.sh --scope user --uninstall           # refuses if files were modified (use --force to keep a backup)
claude mcp remove devpanel -s user                                    # only if you also want to remove the MCP server entry
```

Credentials stay where you configured them (Claude Code, `gh`, DevPanel); revoke the PAT on GitHub if it is no longer needed. Execution records are in `~/.local/state/dp-ai-toolkit/runs/`.

## Checks

```bash
node --test tests/*.test.mjs
```

Local and mock-based only: installer behaviour (scopes, idempotence, protection, MCP registration), helper validation (server configuration mapping, branch helper with a fake `gh`, site check, Drupal inspector, execution record secret refusal), the PAT helper's secret handling (hidden input in a pseudo-terminal, redaction, token-type checks, OAuth/PKCE and bearer against fake servers), diagnostics, and repository hygiene. None of these contact DevPanel or GitHub. Live integration tests need a designated non-production DevPanel workspace and the real approval protocol.
