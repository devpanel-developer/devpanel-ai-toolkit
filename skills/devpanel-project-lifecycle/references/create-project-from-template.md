# Create a project from a DevPanel catalog template

Tested flow: **quickclone**. DevPanel creates a NEW PRIVATE repository under the chosen owner, copies the catalog repository's `main` branch into it, creates the project with its `main` application, and deploys it once the copy job succeeds. Do not use `devpanel_plan_quickstart_project` (turned off on the server; it deploys the catalog's own repository).

A DevPanel catalog template is not the toolkit's local `templates/` directory.

## Inputs

| Input | Source |
|---|---|
| Workspace | User, resolved via `devpanel_list_workspaces` |
| Catalog | User's description ("Drupal CMS"), resolved via `devpanel_list_catalogs` — never a hardcoded ID |
| Project name | User; must be unused in the workspace |
| Repository owner | User or org from `devpanel_list_git_owners` |
| Repository name | User; must **not** exist yet |

Quickclone deploys with the catalog's own configuration; it takes no CPU/PHP/MySQL inputs. If the user asks for specific server settings, say they cannot be set in this step; after deployment they are a separate `devpanel_plan_upgrade_application` request (and MySQL is cluster-level, see `devpanel-project-requirements.md`).

## Procedure

1. **Identity.** `devpanel_whoami`. Check `githubUsername` is present and is the account the user expects. If missing → PAT setup first (`execution-and-verification.md` §9); quickclone otherwise fails with `CreateRepo Not Found`.
2. **Workspace.** `devpanel_list_workspaces` → `workspaceId`.
3. **Catalog.** `devpanel_list_catalogs` with `workspaceId` passed explicitly (omitting it returned 404 in testing). Match the user's request by name/project type. Require `status` `ACTIVE` (or absent) and a non-private `visibility`; quickclone refuses private catalogs. If several match, list them (name, ID, project type, repository) and ask. Record the catalog ID used.
4. **Git owner and saved PAT.** `devpanel_list_git_owners` (provider `GITHUB`). `Bad credentials` → the DevPanel PAT must be replaced (§9) before continuing. Confirm the chosen `repositoryOwner` is in the list; if it is not, warn that repository creation will fail unless the PAT can create repositories there.
5. **Repository must not exist.** Check both:
   - `gh repo view OWNER/NAME --json name` → must fail with "Could not resolve"/not found. If it exists, ask for another name. (If `gh` lacks access to that owner, say the check was inconclusive and rely on step 6.)
   - The plan itself refuses names that `devpanel_list_repositories` already shows.
6. **Plan.** `devpanel_plan_quickclone_project` with:
   ```json
   { "workspaceId": "<id>", "catalog": "<catalog id>", "name": "<project name>",
     "repositoryOwner": "<owner>", "repositoryName": "<new repo>",
     "repositoryProvider": "GITHUB", "isUsePersonalToken": true }
   ```
   `isUsePersonalToken: true` is required: the server default (`false`, OAuth connection) used an expired credential in testing. Check the plan's warnings (new private repository, immediate deployment, testing-workspace limit of 3 running applications).
7. **Approve and execute** per `execution-and-verification.md` §2.
8. **Monitor.** The result carries `cloneActivityId` and the deploy `activityId`/`jobStatus`. If `cloneJobStatus` is not `SUCCESS`, poll `devpanel_get_activity` on `cloneActivityId`; DevPanel deploys only after the clone succeeds. Then poll the deploy activity (§4). Do not submit an activation unless the application is actually in `UNDEPLOY_APPLICATION_SUCCESS` after the jobs finish.
9. **Read back.**
   - `devpanel_list_projects` / `devpanel_get_project` → project ID, `repository` = `OWNER/NAME`, `catalogId` matches.
   - `devpanel_list_project_applications` → the `main` application; `devpanel_get_application` → status, `hostname`.
   - `gh-branch.sh lookup OWNER/NAME main` → record the SHA.
10. **Verify the site** (§5). On HTTP 5xx after a `SUCCESS` job, read activity logs and HTTP logs and report; do not re-run quickclone.
11. **Report** (§8): project ID, repository (new, private), application ID and URL, catalog ID used, activity IDs, verification result.

## Failure handling

| Failure | Action |
|---|---|
| Plan refused: project name exists | Ask for another name, or offer the existing-project workflows |
| Plan refused: repository exists | Ask for another repository name; quickclone never reuses a repository |
| Clone job `ERROR` | Read its logs. The repository may already exist (partially created) — check with `gh repo view` and report; a retry needs a different repository name or the user's decision about the existing one |
| Deploy job `ERROR` | Project and repository exist: report partial completion; inspect logs; the next step is a fresh activation plan only if the application is `UNDEPLOY_APPLICATION_SUCCESS` |
| Timeout | Report pending with activity IDs; resume monitoring later |

Rollback is never automatic. If the user wants cleanup: `devpanel_plan_delete_project` (deletes applications and project in one plan); the GitHub repository must be deleted by the user.

## Not part of this workflow

Database/files sync from another environment, new branch environments, and server configuration changes are separate requests.
