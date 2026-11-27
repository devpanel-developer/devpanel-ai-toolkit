# Evidence for toolkit behaviour

What the skill relies on, and how it was established. Re-check these facts when DevPanel or the DevPanel MCP server changes.

## User-tested workflows (functional baseline)

Reported by the user as successfully executed through AI: catalog project creation via quickclone; project creation from an existing GitHub repository with user-selected server configuration; branch creation with `gh`; new-branch environment creation (branch sync + activation); database/files sync A→B. Observations from those runs that the skill encodes:

- `devpanel_list_catalogs` without `workspaceId` returned 404 → always pass it.
- Missing `githubUsername` caused `CreateRepo Not Found` → check `devpanel_whoami` first.
- Quickclone's default OAuth path used an expired credential → `isUsePersonalToken: true`.
- `Bad credentials` from git owners → the PAT in DevPanel must be replaced.
- Plans expired after 15 minutes.
- Quickclone + deploy took about four minutes.
- A copy job reported `SUCCESS` while the site returned HTTP 500.
- Tested Drupal CMS deployment: image `drupalforge/drupal_cms:main`, capacity `small_2`, explicit web root.

## DevPanel MCP behaviour

| Behaviour | Consequence in the skill |
|---|---|
| Approval: `devpanel_approve_and_execute_plan` first with `planId` only, then `decision` + `planHash`; a hash mismatch is refused | Shared approval protocol |
| Seven change tools run when called, without approval: `devpanel_backup_application`, `devpanel_unpause_application`, `devpanel_extend_application_expiry`, `devpanel_disable_code_server`, `devpanel_disable_phpmyadmin`, `devpanel_set_force_https`, `devpanel_configure_daily_backup` (the former `devpanel_plan_backup_application` / `devpanel_plan_unpause_application` no longer exist) | Backup before sync and unpause are direct calls, announced to the user first |
| `devpanel_wait_for_activity` waits for a job (default 120 s, `done: false` on timeout); `done: true` does not mean `SUCCESS` | Monitoring waits instead of polling and always reads `status` |
| `devpanel_get_application_status` reports pod health (`HEALTHY`, `DEGRADED`, `DOWN`, `PAUSED`, `UPDATING`, `NOT_DEPLOYED`) but does not probe HTTP | Used before, not instead of, `check-site.sh` |
| `devpanel_list_plans` lists the session's plans; plans are kept in server memory | Reconciliation does not rely on plans surviving |
| `devpanel_plan_quickstart_project` is turned off; quickclone creates a new private repository, copies the catalog's `main`, creates project + main application, deploys after the clone job | Template workflow uses quickclone only |
| Quickclone refuses existing repository names, existing project names and private catalogs; `isUsePersonalToken` defaults to `false` | Pre-checks; always pass `true` |
| `devpanel_plan_sync_project_branches` creates one undeployed application for every branch (first 50 on GitHub) without one; refuses when there are none; never removes | Plan-scope inspection in the branch workflow |
| `devpanel_plan_create_application` creates a project; against a real DevPanel it needs `repositoryId`; real creation can be disabled server-side | Repository workflow gets `repositoryId` from `devpanel_list_repositories`; server-side refusals are reported, not worked around |
| Activation accepts `capacity`, `capacityLimit`, `containerImage`, `appRoot`, `webRoot`, `storage`, `copyDatabaseFilesType`, `isFromGit`; omitted fields get generic defaults (`micro`, `devpanel/php:8.3-base-rc`, `/var/www/html/web`, 5 GiB) | Every field passed explicitly |
| The generic-defaults plan warning does not cover `capacityLimit` | `capacityLimit` always passed (normally = `capacity`) |
| No tool has a MySQL parameter | MySQL handled as a cluster-level confirmation |
| `devpanel_get_application_config` returns `runtime` (`containerImage`, `capacity`, `capacityLimit`, `storageGi`, `groupType`, `replicas`) and `paths` (`appRoot`, `webRoot`, `staticFiles`); `null` = not reported; no credentials, no MySQL version | Reference app's settings are offered for reuse; `null` fields are asked for |
| Sync copies DB + static files in one job: the target database is dropped and replaced (source hostname rewritten), files are merged (same path overwritten, target-only kept), the target is down during the database copy; same project only; both deployed with 1 replica and a static files path; the target returns to `DEPLOY_APPLICATION_SUCCESS` even on failure; the result carries `jobStatus`, `activityId` and `fileCheck` | Sync workflow validates first, states replace/merge/downtime, judges success by the activity and reports file counts |
| `devpanel_plan_import_file` reads `sourcePath` on the MCP server's machine (not the user's computer when the server is remote); `devpanel_plan_run_command` needs a command access token and writes its output to a publicly served log | Data import through the hosted server stays manual; `drush cr` after a sync is offered, never automatic |
| The server offers 13 task guides as MCP prompts (`create-site`, `troubleshoot-site`, ...) | Tasks outside this skill are pointed to those prompts |
| `devpanel_list_backups` exposes `databaseStatus`/`filesStatus` | Backup verified before sync |
| `devpanel_set_git_token` requires `token` and `username` (provider default GITHUB) and mutates directly, outside the plan protocol | Never called by Claude; only by the setup helper or the DevPanel UI |
| The DevPanel MCP server runs over HTTP; authentication is MCP OAuth (dynamic client registration + PKCE), a static bearer, or a bring-your-own token | Helper supports each path on its own; it never reuses Claude Code's session |
| The server's session may not belong to the person running the helper | Helper shows `devpanel_whoami` and requires confirmation before saving a token |

## Server configuration mapping (DevPanel platform)

- CPU/memory are coupled capacity tiers (`assets/server-config.json`); DevPanel's capacity listing offers `over_commit` … `medium_2`. Requests come from the tier, limits from `capacityLimit`; `over_commit` forces `capacityLimit = large_1`.
- PHP is selected through the container image (`devpanel/php:<version>-base|secure|advance`); each project type has a default image.
- MySQL engine and version belong to the workspace's environment (cluster) and apply to all its applications.
- Drupal PHP minimums (10 → 8.1, 11 → 8.3): Drupal upstream system requirements.

## Drupal `.devpanel` evidence

- DevPanel reads and validates `.devpanel/config.yml` if present.
- Deployments select a run script by name: `re-config.sh` for deployments from Git, a database URL or a copy; otherwise `init.sh`. Catalogs can override it.
- Not established: how the deployment executes the script. Therefore no production template (`templates/drupal/README.md`).
