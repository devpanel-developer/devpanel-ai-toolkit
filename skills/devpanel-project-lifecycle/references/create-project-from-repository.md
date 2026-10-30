# Create a project from an existing GitHub repository

Tested flow: create the project and its first application from a repository branch, activate it with the user's server configuration, verify. Server configuration is user input; everything else runs under the MCP approval protocol.

## Inputs

| Input | Source |
|---|---|
| Workspace | `devpanel_list_workspaces` |
| Repository `OWNER/NAME` | User; validated with `gh` and with DevPanel's Git integration |
| Branch | User (default: repository default branch, confirmed with the user) |
| Project name | User; must not clash with an existing application/project name |
| Project type | `devpanel_list_project_types`, matched to the codebase (e.g. `drupal11_v2` for Drupal 11) |
| Server configuration | CPU/memory tier, PHP, MySQL — user's choice (`devpanel-project-requirements.md`) |
| App root / web root | From the codebase layout (Drupal: `inspect-drupal-source.mjs`) and confirmed |

Reuse any of these the user already stated; do not ask again.

## Procedure

1. **Preflight** (`execution-and-verification.md` §1): identity, workspace, then both Git credentials independently:
   - `gh-branch.sh access OWNER/NAME` (CLI access).
   - `devpanel_list_git_owners` and `devpanel_list_repositories` with `owner: OWNER` (DevPanel PAT access). Find the repository; record its `id` — `devpanel_plan_create_application` needs it as `repositoryId` against a real DevPanel. If the repository is missing here but visible to `gh`, the DevPanel PAT lacks access (scope, owner, or org SSO); stop and fix the PAT.
2. **Branch.** `gh-branch.sh lookup OWNER/NAME BRANCH`.
   - Exists → record SHA.
   - Missing and the user asked for it to be created → follow `create-branch-environment.md` §2 (explicit base, resolved SHA, non-forcing create).
   - Missing and not requested → ask.
3. **Project type.** `devpanel_list_project_types`; choose the key matching the stack (for Drupal, from the detected core major). Confirm with the user if more than one fits.
4. **Existing resources.** `devpanel_list_projects` and `devpanel_list_applications` (search by name) in the workspace. If a project already uses this repository, this is not a new project: offer `create-branch-environment.md` instead. If the name is taken, ask for another.
5. **Server configuration.** Show the options together (tiers with CPU/memory, PHP images, the MySQL cluster-level constraint, storage) from `devpanel-project-requirements.md`. Suggest a compatible configuration if helpful, but get the user's explicit selection. Then map it:
   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/server-config.mjs" map --capacity <tier> --php <ver> --mysql <cluster-default|ver> \
     --app-root <appRoot> --web-root <webRoot> --project-type <type> [--drupal-major <n>] [--storage <GiB>]
   ```
   Exit 3 → explain the constraint and resolve it with the user before continuing. Do this before any plan so the activation plan can follow the create plan without expiry pressure.
6. **Create plan.** `devpanel_plan_create_application`:
   ```json
   { "workspaceId": "<id>", "name": "<project name>", "repositoryOwner": "<OWNER>", "repositoryName": "<NAME>",
     "repositoryProvider": "GITHUB", "repositoryId": "<id from devpanel_list_repositories>",
     "branch": "<branch>", "projectType": "<type>" }
   ```
   Plan errors `Real CREATE is disabled` / create-profile errors are MCP server configuration; report them, do not work around.
7. **Approve and execute** (§2). The result is the project's first application.
8. **Read back.** `devpanel_list_projects` → project ID; `devpanel_get_project` → `repository` is `OWNER/NAME`, project type as chosen; `devpanel_list_project_applications` → the application with `originBranch` = branch. If the association does not match, stop and report.
9. **Activate if needed** (state table §3). For `UNDEPLOY_APPLICATION_SUCCESS`: `devpanel_plan_activate_application` with `workspaceId`, `application: <application ID>` and every field from step 5 (`capacity`, `capacityLimit`, `containerImage`, `appRoot`, `webRoot`, `storage`, `copyDatabaseFilesType: ""`, `isFromGit: true`). The plan must not show a "generic defaults" warning; if it does, a field is missing — create a corrected plan instead of approving. Approve and execute (§2).
10. **Monitor and verify** (§4, §5).
11. **Report** (§8) including the selected configuration, its MCP mapping and the user-confirmed MySQL version. Do not sync database/files.

## Failure handling

- Create succeeded, activation rejected or failed: the project exists; report partial completion and the activation as the next step.
- Activation job `ERROR`: read activity logs (missing Composer dependencies, wrong web root and wrong PHP image are common causes) and report. A new activation plan is possible only if the application returns to `UNDEPLOY_APPLICATION_SUCCESS`; changing settings on a deployed application is `devpanel_plan_upgrade_application` and needs a separate approval.
- HTTP 500 or `install_required` after `SUCCESS`: code is deployed; the site may need its database. Importing an existing site's data is not supported by a verified mechanism (see `deploy-existing-site.md`); report it.
