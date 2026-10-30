---
name: devpanel-project-lifecycle
description: Create and run DevPanel projects and environments through the DevPanel MCP server together with GitHub CLI and Git. Use when the user asks to create a DevPanel project from a catalog template or from an existing GitHub repository, add an environment for a branch of an existing DevPanel project, copy (sync) database and files from one DevPanel environment to another, prepare an existing Drupal codebase for deployment on DevPanel, or check the DevPanel toolkit setup (DevPanel identity, workspaces, GitHub access).
---

# DevPanel project lifecycle

Coordinates DevPanel MCP (discovery, plans, approval, activities, logs) with `gh`/Git (repository and branch work). DevPanel MCP tools appear in Claude Code as `mcp__<server>__devpanel_*`; this skill uses the bare tool names.

## Route the request

Read `references/execution-and-verification.md` first for every workflow, then the one reference that matches the request:

| User wants | Reference |
|---|---|
| New project from a DevPanel catalog template (e.g. "Drupal CMS") | `references/create-project-from-template.md` |
| New project from an existing GitHub repository | `references/create-project-from-repository.md` |
| Environment for a branch of an existing project (new or existing branch) | `references/create-branch-environment.md` |
| Copy database and files from environment A to B | `references/sync-environment-data.md` |
| Prepare an existing customer Drupal site for DevPanel | `references/deploy-existing-site.md` |
| Check the toolkit setup / credentials (read-only) | `references/execution-and-verification.md` §1 and §9 only; no plans |

`references/devpanel-project-requirements.md` holds the verified server-configuration mappings (CPU/memory tiers, PHP images, MySQL) and Drupal file requirements. Read it before collecting server configuration or touching customer source.

If the request is ambiguous between workflows (e.g. "set up staging" could mean a branch environment, a sync, or both), ask which operation the user wants. Never combine workflows the user did not ask for.

## Shared rules

1. **Approval protocol.** Every DevPanel mutation is a plan. Call `devpanel_approve_and_execute_plan` with `planId` only, show the returned `plan_text` verbatim, then stop and wait. Relay only the user's literal `APPROVE`/`REJECT` with that plan's `planHash`. The original workflow request is not approval of a plan the user has not seen. Never supply `decision` on the first call.
2. **No automatic data sync.** Creating, activating or unpausing an application never triggers `devpanel_plan_sync_application`, and activation always passes `copyDatabaseFilesType: ""`. Sync only on an explicit user request for that operation.
3. **Secrets stay out of the conversation.** Never ask for, accept, echo or store a GitHub token, DevPanel token or password. Never call `devpanel_set_git_token` yourself; direct the user to the setup helper or the DevPanel UI (see `references/execution-and-verification.md`). Never call `devpanel_get_project_secret` or `devpanel_get_backup_download_url` unless the user explicitly asks for that value.
4. **Resolve, then reuse.** Resolve workspace, project, repository, branch and application to stable IDs before any mutation. Reuse matching resources; create only what is missing. If more than one candidate matches, ask the user to choose.
5. **Use the verified tool for each step.** Quickclone for catalog templates (not quickstart); branch reconciliation (`devpanel_plan_sync_project_branches`) for branch applications in an existing project (not `devpanel_plan_create_application`). Do not invent tool parameters; check the live tool schema when unsure.
6. **Server configuration is the user's choice.** Show supported options from `devpanel-project-requirements.md`, reuse choices the user already gave, and get an explicit selection before activation. Never rely on the MCP's stack-unaware activation defaults.
7. **Verify outcomes.** Poll activities to a terminal state with a deadline, then load the site. A `SUCCESS` job is not proof the website works.
8. **Never force or delete as rollback.** No force-push, no branch reset, no automatic deletion or restore. Report partial completion and the next step instead.
9. **Keep an execution record** with `${CLAUDE_SKILL_DIR}/scripts/exec-record.mjs` and finish with the report format in `execution-and-verification.md`.

## Helpers

All under `${CLAUDE_SKILL_DIR}/scripts/` (Node.js 18+, `gh`, `curl`):

- `gh-branch.sh` — repository access check, exact branch lookup, base SHA resolution, non-forcing branch creation.
- `server-config.mjs` — list supported server options and map a user's selection to activation arguments.
- `check-site.sh` — HTTP readiness check of an application URL.
- `exec-record.mjs` — structured execution record that rejects secret values.
- `inspect-drupal-source.mjs` — read-only inspection of a local Drupal codebase.
