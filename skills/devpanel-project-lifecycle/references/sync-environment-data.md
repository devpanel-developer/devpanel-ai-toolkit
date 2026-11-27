# Synchronize database and files between environments

Only on an explicit user request to copy data from environment A (source) to environment B (target). Never as a side effect of creating or activating an application, even when another application exists in the project.

`devpanel_plan_sync_application` always copies **both the database and the static files** from source to target in one job. There is no database-only or files-only option; if the user asks for one part only, say so and let them decide. The source is not modified. Cross-project sync is not possible.

What happens to the target:

- **Database: replaced.** The target database is dropped and recreated from a dump of the source. Every occurrence of the source hostname in the dump is rewritten to the target hostname. Nothing of the old target database survives.
- **Static files: merged, not mirrored.** Source files are copied over the target's static files path. Files with the same path are overwritten; files that exist only on the target are kept. A sync never deletes target files.
- **Downtime.** The target is scaled to 0 replicas while the database is copied and back to 1 afterwards.

## Inputs

- Workspace.
- Source application and target application, each resolved to an ID (by project + branch, not display name alone). They must differ and belong to the same project.

## Procedure

1. **Preflight** (`execution-and-verification.md` §1).
2. **Resolve both applications.** `devpanel_list_project_applications` for the project; match source and target by `originBranch`. Then `devpanel_get_application` and `devpanel_get_application_config` for each. Confirm with the user which is source and which is target, in those words ("the target database will be replaced; its files will be merged with the source's").
3. **Validate**:
   - Different IDs, same `projectId` and workspace.
   - Both `DEPLOY_APPLICATION_SUCCESS` with `runtime.replicas` 1 (paused → offer `devpanel_unpause_application`, which runs at once without approval, and call it only if the user agrees; more than 1 replica → DevPanel refuses).
   - Both have a static files path (`staticFiles` non-empty). If missing, propose `devpanel_plan_set_static_files_path` for that application with a path inside its `webRoot` (Drupal: `<webRoot>/sites/default/files`); this is its own plan and approval.
   - No activity in progress on either application.
4. **Back up the target.**
   - Tell the user a backup of the target is being started, then `devpanel_backup_application` (target). It runs at once, with no approval step, and changes nothing existing. Note the backup ID.
   - Poll `devpanel_list_backups` (target) until that backup shows `databaseStatus` and `filesStatus`. Both must be `SUCCESS` before continuing. If either is `ERROR`, or `filesStatus` is absent, stop: report that a complete restore point does not exist and let the user decide.
5. **Sync plan.** `devpanel_plan_sync_application` with `workspaceId`, `application: <target ID>`, `sourceApplication: <source ID>`. Check the plan text names the right source/target, shows the DATABASE / STATIC FILES / DOWNTIME warnings, and references the new backup as the latest target backup. If the plan cites an older backup, the new one is not visible yet; wait and re-plan.
6. **Approve and execute** (§2). The plan text states what is replaced, what is merged and the downtime; that is what the user approves.
7. **Monitor.** The target goes `UPGRADING` and returns to `DEPLOY_APPLICATION_SUCCESS` whether the job succeeded or failed. The execution result carries `jobStatus` and `activityId`; if `jobStatus` is not final yet, `devpanel_wait_for_activity` with the `activityId` until `SUCCESS`/`ERROR`/`CANCEL` (§4). On `SUCCESS` the result also carries `fileCheck`: `{ sourceFiles, targetFiles }` from DevPanel's own post-copy check (`targetFiles` >= `sourceFiles`, since target-only files are kept), or a `note` when the counts could not be read from the job logs — then check `devpanel_get_activity_logs`.
8. **Verify the target** (§5): `devpanel_get_application_status`, then `check-site.sh` on the target URL; HTTP logs if 5xx. A `SUCCESS` sync followed by HTTP 500 is a known pattern (e.g. cached paths/hostnames from the source); report it with logs rather than claiming success. For Drupal, a cache rebuild (`drush cr` through `devpanel_plan_run_command`) usually clears it: offer it, and run it only if the user agrees. It is a separate HIGH-risk plan, needs a saved command access token, and its output is served publicly by the site; follow the server's `run-command` prompt.
9. **Report** (§8): source, target, backup ID with component statuses, sync activity result, file counts (`fileCheck`), verification result.

## Failure handling

- Sync `ERROR`/`CANCEL`, or site broken after sync: keep the application and backup; report partial completion and propose recovery. Restoring is `devpanel_plan_restore_application` (backup ID, `database`/`files` flags for parts whose status is `SUCCESS`) — a separate, explicitly requested and approved operation. Never restore or re-run the sync automatically.
- Timeout: report pending with the activity ID; resume monitoring later.
- Do not use `devpanel_get_backup_download_url` (signed URLs) and never store such URLs in records.
