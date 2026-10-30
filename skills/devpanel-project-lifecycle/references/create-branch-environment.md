# Create an environment for a branch of an existing project

**Project → repository branch → application → activation → verification.**

Reuse an existing branch or application when it matches; create only what is missing. Creating or activating an application never copies database or files; that is `sync-environment-data.md`, only on explicit request.

"Environment" here means a DevPanel application running a branch. It is not a Kubernetes cluster (`devpanel_list_environments`); cluster provisioning is not supported.

## Inputs

- Workspace and existing project → IDs.
- Target branch name.
- Base branch, only if the target branch must be created: from an explicit project policy the user stated, or ask. Never assume `main`.
- Server configuration for activation (tier, PHP image, MySQL constraint, roots) — user's choice.

Repository and project type come from the project (`devpanel_get_project`). Do not guess them or pick the first matching project.

## 1. Preflight

1. `execution-and-verification.md` §1 (identity, workspace, record).
2. `devpanel_list_projects` → resolve the project; if several match, ask. `devpanel_get_project` → `repositoryOwner`, `repositoryName`, `repositoryProvider`, `projectType`. A project without repository owner/name cannot get branch environments; stop.
3. `devpanel_list_project_applications` → existing applications (`originBranch`, `displayName`, status).
4. Credentials, separately: `gh-branch.sh access OWNER/REPO` (CLI) and `devpanel_list_git_owners` (DevPanel PAT).
5. Validate the branch name: `git check-ref-format --branch <name>` (the helper does this too).
6. Record target and existing IDs before any mutation.

## 2. Prepare the branch (gh)

```bash
S="${CLAUDE_SKILL_DIR}/scripts/gh-branch.sh"
"$S" lookup OWNER/REPO TARGET          # exit 0: exists (prints sha), 1: absent, 2: error
```

- **Exists** → reuse; record its SHA. Never reset it to the base.
- **Absent** → the user must have asked to create it (a request for an environment for a branch that does not exist counts only if they named a base or confirm one now).
  ```bash
  "$S" resolve-base OWNER/REPO BASE      # prints the base commit SHA
  "$S" create OWNER/REPO TARGET <sha>     # creates refs/heads/TARGET at exactly <sha>; never forces
  ```
  `create` reads the branch back. If it reports `"created": false` (someone created it concurrently), use the actual SHA it reports and tell the user if it differs from the base.
- **Error (exit 2)** → authentication/permission/network; report it. Do not claim the branch exists.

Use `gh`/Git only; DevPanel MCP's branch listing shows at most 50 branches and is not proof of absence.

## 3. Create or reuse the application

1. From the applications listed in §1.3, match `originBranch` (or `displayName`) == TARGET.
   - Exactly one → reuse it.
   - More than one → ask the user which one.
   - None → continue.
2. **Branch reconciliation plan:** `devpanel_plan_sync_project_branches` with `workspaceId` and `project: <project ID>`. This creates one undeployed application for **every** repository branch (first 50 on GitHub) that has no application in the project.
3. **Inspect the plan scope** before approval:
   - `target.newBranches` must contain TARGET. If it does not (branch beyond the first 50, or name mismatch), do not execute; report the limitation.
   - If it lists other branches too, tell the user exactly which extra applications would be created and get their decision. The approval of the plan text is the authorization; an `APPROVE` covers all listed branches. If they do not want the extra applications, do not execute (the tool has no single-branch mode); offer to stop or to proceed knowingly.
   - Do not substitute `devpanel_plan_create_application`: it creates a new project rather than attaching to this one.
4. Approve and execute (`execution-and-verification.md` §2). The result lists `createdApplications`.
5. Re-read `devpanel_list_project_applications`; identify the TARGET application by `originBranch`; confirm it belongs to the project (same `projectId`) and status `UNDEPLOY_APPLICATION_SUCCESS`.

## 4. Activate or resume

Read the application (`devpanel_get_application`) and follow the state table in `execution-and-verification.md` §3.

For activation:
1. Read an existing application of the project (e.g. the `main` one) with `devpanel_get_application` as a reference: it gives `webRoot` and `staticFiles`. Image, tier and storage are not returned by MCP — ask the user or have them check the DevPanel UI.
2. Present the configuration options (`devpanel-project-requirements.md`) together with the reference values, and get the user's selection (unless they already gave it for this target).
3. Map: `server-config.mjs map ...` (exit 3 → resolve first).
4. `devpanel_plan_activate_application` with `workspaceId`, `application: <application ID>` and all mapped fields, including `capacityLimit`, `appRoot`, `webRoot`, `containerImage`, `storage`, `copyDatabaseFilesType: ""`. The plan must carry no generic-defaults warning.
5. Approve and execute.

Paused (`replicas` 0) → `devpanel_plan_unpause_application`. Already running → reuse, no activation, no runtime changes.

The tested Drupal deployment used `drupalforge/drupal_cms:main` with `small_2` and an explicit web root. Those are examples for that project, not defaults.

## 5. Verify

`execution-and-verification.md` §4–§5: activity to a terminal state, application re-read (project, branch, status, URL), `check-site.sh`. Report the branch SHA observed and that the deployed commit cannot be verified through MCP.

A fresh branch application has no copy of another environment's database or files; `install_required` or an empty site is expected. Mention that `sync-environment-data.md` is available if they want data from another environment — but do not start it.

## 6. Report

`execution-and-verification.md` §8: branch created/reused + SHA, application created/reused + ID + URL, other applications created by the branch reconciliation plan, configuration, verification result.
