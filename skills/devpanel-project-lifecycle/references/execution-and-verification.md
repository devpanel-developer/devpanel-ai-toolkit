# Execution and verification

Shared procedure for every workflow in this skill: preflight, the plan approval protocol, activity monitoring, readiness verification, retry, records and the final report.

## 1. Preflight (every workflow)

1. `devpanel_whoami` — confirm the DevPanel identity is the user's. Note `githubUsername`; it matters for repository operations (a missing value caused `CreateRepo Not Found` in testing).
2. `devpanel_list_workspaces` — resolve the target workspace to an ID. Pass `workspaceId` explicitly on every later call that accepts it; do not rely on the server default.
3. When the workflow touches GitHub, check the two Git credentials **separately**:
   - GitHub CLI: `${CLAUDE_SKILL_DIR}/scripts/gh-branch.sh access OWNER/REPO` (exit 0 = readable; `push: true` needed to create branches).
   - DevPanel Git integration: `devpanel_list_git_owners` (provider `GITHUB`). `Bad credentials` or an empty list means the PAT classic saved in DevPanel is missing, expired or under-scoped.
   Success of one never proves the other.
4. Start an execution record (section 7).

If the DevPanel MCP tools are missing or return authentication errors, stop and point the user to setup (section 9). Do not work around it.

## 2. Plan approval protocol

DevPanel MCP mutates nothing until a human approves an immutable plan.

1. Gather every input first (plans expire; 15 minutes in the tested server). Respect the `expiresAt` returned with the plan.
2. Create the plan with the relevant `devpanel_plan_*` tool. Read its `summary`, `target`, `steps` and `warnings`. If the plan's scope differs from what the user asked for (more applications, a different branch, a generic default you did not choose), stop and resolve that before asking for approval.
3. Call `devpanel_approve_and_execute_plan` with **only** `planId`.
4. Show the returned `plan_text` to the user **verbatim**, including the final question. Add nothing that reads as an answer. Stop and wait for the user's reply.
5. The user's reply must literally be `APPROVE` or `REJECT` (anything else — "ok", "sure", "go ahead", a question — is not a decision: ask them to answer `APPROVE` or `REJECT`).
6. Call `devpanel_approve_and_execute_plan` again with `planId`, `decision` set to the user's answer and `planHash` from that plan.
7. Inspect the result. Record `planId`, the decision and any activity IDs.

Rules:

- Never fabricate, infer or pre-fill a decision. An earlier "do it" or the workflow request itself is not approval of a plan the user has not seen.
- One plan, one approval. A replacement plan (after expiry, `PLAN_STALE` or a changed input) needs a fresh `APPROVE` for its new hash.
- `PLAN_EXPIRED` / `PLAN_STALE`: re-read current state (the first attempt may have partially happened), create a new plan, approve again.
- `PLAN_INTEGRITY_FAILED`: the hash did not match; re-run step 3 to show the current plan.
- `PLAN_REJECTED` / user answered `REJECT`: stop that branch of the workflow and report what was completed before it.
- `EXECUTION_FAILED`: do not retry blindly. Read the plan (`devpanel_get_plan`), activities and logs, then reconcile (section 6).

## 3. Application state decisions

Read state with `devpanel_get_application` (workspaceId + application ID) before choosing an operation:

| State | Action |
|---|---|
| `UNDEPLOY_APPLICATION_SUCCESS` | Activation plan (`devpanel_plan_activate_application`) with user-selected configuration |
| `DEPLOY_APPLICATION_SUCCESS`, `replicas` ≥ 1 | Running: reuse, no activation |
| `DEPLOY_APPLICATION_SUCCESS`, `replicas` = 0 | Paused: `devpanel_plan_unpause_application` |
| `UPGRADING` or another in-progress status, or a `PENDING`/`IN_PROGRESS` activity | Monitor the existing activity first (section 4); do not submit another operation |
| Any error status or unknown value | Inspect `devpanel_get_application_activities` and `devpanel_get_activity_logs`; report or resolve before proceeding |

Do not change runtime settings of an already running application as a side effect of these workflows. Changing them is `devpanel_plan_upgrade_application`, a separate user request.

## 4. Monitoring activities

Execution results carry activity IDs (`activityId`, `cloneActivityId`), or the application's latest activity is visible in `devpanel_get_application_activities`.

- Poll `devpanel_get_activity` until `status` is `SUCCESS`, `ERROR` or `CANCEL`.
- Interval: about 20 seconds. Deadlines (observations, not guarantees): quickclone + deploy 20 minutes (the tested run took about 4), activation 15 minutes, data sync 30 minutes, backup 15 minutes. Never poll in a tight loop.
- On `ERROR`/`CANCEL`: read `devpanel_get_activity_logs` (raise `pageSize` for more lines) and report the failing step.
- On deadline: the operation is **pending/unknown**, not failed. Record the activity ID, report it, and tell the user how to resume ("continue monitoring activity <id>"). Never submit a duplicate job because of a timeout.

## 5. Readiness verification

A `SUCCESS` activity or `DEPLOY_APPLICATION_SUCCESS` status does not prove the site works (a successful copy job still returned HTTP 500 in testing).

1. Re-read the application: confirm project ID, `originBranch`, status, `replicas`, and `hostname` (the URL).
2. Run `${CLAUDE_SKILL_DIR}/scripts/check-site.sh https://<hostname>`. Exit 0 = ready. It reports the final status code and known error markers (Drupal fatal error, database connection failure, installer redirect).
   - `auth_protected` (401/403): the app is behind basic auth or access control; report that readiness was verified only up to the auth layer unless the user provides another check.
   - `install_required`: Drupal reached its installer; code is deployed but there is no installed site/database.
   - Status 5xx or `error_marker`: read `devpanel_get_http_logs` (container `php`) and the deploy activity logs.
   - New deployments can take a minute to serve after `SUCCESS`; `--retries 6 --interval 20` is reasonable once.
3. Commit-level verification: record the branch SHA observed via `gh`. DevPanel MCP exposes no deployed-commit field, so report "deployed commit not verifiable via MCP" rather than claiming the SHA is live.

## 6. Retry and reconciliation

Before any retry, rebuild the picture from live state instead of from memory:

- Branch: `gh-branch.sh lookup` (exists? which SHA?).
- Applications: `devpanel_list_project_applications`; match on `originBranch`/`displayName`.
- Plans: `devpanel_get_plan` for recorded plan IDs (status `SUCCEEDED`, `FAILED`, `STALE`, ...).
- Activities: `devpanel_get_activity` for recorded activity IDs.

Reuse what already matches the request. Resume monitoring pending activities. A resource that exists but does not match (branch at an unexpected SHA, an application on another branch with the requested name) needs the user's decision; never overwrite, reset or delete it.

If a GitHub step succeeded and a later DevPanel plan was rejected or failed, keep the branch and report partial completion.

## 7. Execution record

Keep one record per workflow run. It never contains secrets; the helper refuses token-, password- and signed-URL-shaped values.

```bash
R=$(node "${CLAUDE_SKILL_DIR}/scripts/exec-record.mjs" init --workflow create-branch-environment)
node "${CLAUDE_SKILL_DIR}/scripts/exec-record.mjs" set "$R" target.workspaceId=<id> target.projectId=<id> target.repository=owner/repo target.branch=feature-x
node "${CLAUDE_SKILL_DIR}/scripts/exec-record.mjs" add "$R" planIds <planId>
node "${CLAUDE_SKILL_DIR}/scripts/exec-record.mjs" add "$R" activityIds <activityId>
node "${CLAUDE_SKILL_DIR}/scripts/exec-record.mjs" add "$R" completedSteps "branch reused at <sha>"
node "${CLAUDE_SKILL_DIR}/scripts/exec-record.mjs" add "$R" pending "monitor activity <id>"
node "${CLAUDE_SKILL_DIR}/scripts/exec-record.mjs" show "$R"
```

Records live in `${XDG_STATE_HOME:-~/.local/state}/dp-ai-toolkit/runs/`, outside any repository. On retry, `list` and `show` the previous record first.

## 8. Final report

Report, in this order, only what was observed:

- Workspace, project (ID) and repository.
- Branch: name, created or reused, observed SHA.
- Application: ID, URL, created or reused, status.
- Server configuration selected and how it mapped to MCP fields (plus the user-confirmed MySQL version, which is cluster-level).
- Verification: activity results, `check-site.sh` result, limits (auth-protected, deployed commit not verifiable).
- Sync: source, target backup ID and component statuses, sync activity result — only if sync was requested.
- Plans and activity IDs; partial completion; pending activities; the next actionable step.

## 9. Credentials and setup problems

| Symptom | Meaning | Next step |
|---|---|---|
| DevPanel tools absent, or `Needs authentication` | DP MCP not configured or not logged in | User runs `/mcp` in Claude Code and authenticates the `devpanel` server; see the toolkit README |
| `githubUsername` missing in `devpanel_whoami`; `CreateRepo Not Found` | No GitHub username/PAT saved in DevPanel | PAT setup (below) |
| `Bad credentials` from `devpanel_list_git_owners` or a plan | PAT in DevPanel expired or revoked | Replace the PAT (below) |
| Private repository branches missing in DevPanel | PAT lacks `repo` scope or organization SSO authorization | User fixes scopes/authorization on GitHub, then saves again |
| `gh` errors 401/403/404 | GitHub CLI not authenticated or no access | `gh auth login` / `gh auth status`; independent from DevPanel |
| `Real CREATE is disabled` / create profile errors | Server-side configuration of the DevPanel MCP deployment | Report to the MCP operator; do not work around |

**PAT setup (never through this conversation):** the user creates a GitHub PAT **classic** with `repo` scope on GitHub, then either runs the toolkit helper in their own terminal (`node <toolkit>/scripts/dp-mcp-helper.mjs set-git-token --server-url <DevPanel MCP URL>`, hidden input) or saves it in the DevPanel UI. Afterwards re-run `devpanel_whoami` and `devpanel_list_git_owners`. If the user pastes a token into the chat anyway, do not repeat or use it; tell them to revoke it on GitHub and create a new one.
