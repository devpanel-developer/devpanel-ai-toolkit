# Synchronize database and files between environments

Only on an explicit user request to copy data from environment A (source) to environment B (target). Never as a side effect of creating or activating an application, even when another application exists in the project.

`devpanel_plan_sync_application` copies **both the database and the static files** from source to target and **overwrites** the target. There is no database-only or files-only option; if the user asks for one part only, say so and let them decide. The source is not modified. Cross-project sync is not possible.

## Inputs

- Workspace.
- Source application and target application, each resolved to an ID (by project + branch, not display name alone). They must differ and belong to the same project.

## Procedure

1. **Preflight** (`execution-and-verification.md` §1).
2. **Resolve both applications.** `devpanel_list_project_applications` for the project; match source and target by `originBranch`. Then `devpanel_get_application` for each. Confirm with the user which is source and which is target, in those words ("target data will be overwritten").
3. **Validate**:
   - Different IDs, same `projectId` and workspace.
   - Both `DEPLOY_APPLICATION_SUCCESS` with `replicas` 1 (paused → offer `devpanel_plan_unpause_application` as a separate approved step; more than 1 replica → DevPanel refuses).
   - Both have a static files path (`staticFiles` non-empty). If missing, propose `devpanel_plan_set_static_files_path` for that application with a path inside its `webRoot` (Drupal: `<webRoot>/sites/default/files`); this is its own plan and approval.
   - No activity in progress on either application.
4. **Back up the target.**
   - `devpanel_plan_backup_application` (target) → approve and execute → note the backup ID.
   - Poll `devpanel_list_backups` (target) until that backup shows `databaseStatus` and `filesStatus`. Both must be `SUCCESS` before continuing. If either is `ERROR`, or `filesStatus` is absent, stop: report that a complete restore point does not exist and let the user decide.
5. **Sync plan.** `devpanel_plan_sync_application` with `workspaceId`, `application: <target ID>`, `sourceApplication: <source ID>`. Check the plan text names the right source/target, shows the overwrite warning, and references the new backup as the latest target backup. If the plan cites an older backup, the new one is not visible yet; wait and re-plan.
6. **Approve and execute** (§2). The plan text states the overwrite scope; that is what the user approves.
7. **Monitor.** The target goes `UPGRADING` and returns to `DEPLOY_APPLICATION_SUCCESS` whether the job succeeded or failed. Only the `SYNC_APPLICATION` activity status (`activityId` in the result) tells the outcome: poll `devpanel_get_activity` to `SUCCESS`/`ERROR`/`CANCEL` (§4).
8. **Verify the target** (§5): `check-site.sh` on the target URL; HTTP logs if 5xx. A `SUCCESS` sync followed by HTTP 500 is a known pattern (e.g. cached paths/hostnames from the source); report it with logs rather than claiming success.
9. **Report** (§8): source, target, backup ID with component statuses, sync activity result, verification result.

## Failure handling

- Sync `ERROR`/`CANCEL`, or site broken after sync: keep the application and backup; report partial completion and propose recovery. Restoring is `devpanel_plan_restore_application` (backup ID, `database`/`files` flags for parts whose status is `SUCCESS`) — a separate, explicitly requested and approved operation. Never restore or re-run the overwrite automatically.
- Timeout: report pending with the activity ID; resume monitoring later.
- Do not use `devpanel_get_backup_download_url` (signed URLs) and never store such URLs in records.
