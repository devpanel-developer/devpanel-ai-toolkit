# Example requests

What to ask Claude Code, and what the skill does with it. IDs and names below are illustrative.

## Create a project from a catalog template

> Create a new DevPanel project "cms-demo" from the Drupal CMS template in workspace Agency. Put the code in a new repository acme/cms-demo.

Whoami (`githubUsername` present?) → workspace → `devpanel_list_catalogs` with `workspaceId` → git owners (PAT works?) → repository must not exist → `devpanel_plan_quickclone_project` with `isUsePersonalToken: true` → plan text shown verbatim, you answer `APPROVE` → clone and deploy activities monitored → project, repository and application read back → site loaded.

## Create a project from an existing repository

> Deploy acme/site (branch main) to DevPanel as project "acme-site" in workspace Agency. It's Drupal 11.

Claude shows the tiers (e.g. `small_2` = 0.5 CPU / 2 GB), PHP images and explains that MySQL is set by the workspace's cluster, then asks for your choice — unless you already gave it:

> Use small_2, PHP 8.3, 10 GB storage; MySQL whatever the cluster has.

Two plans follow, each approved separately: create application, then activate with `capacity=small_2`, `capacityLimit=small_2`, `containerImage=devpanel/php:8.3-base`, explicit roots, `storage=10`, `copyDatabaseFilesType=""`.

## Environment for a new branch

> In project acme-site, create an environment for branch feature/search, branched from develop.

`gh-branch.sh lookup` → absent → `resolve-base develop` (SHA) → `create` → `devpanel_plan_sync_project_branches` (Claude points out if the plan would also create applications for other branches) → your configuration choice (Claude reads an existing environment's image, tier and storage with `devpanel_get_application_config` and offers to reuse them) → activation plan → verification. No data is copied.

## Environment for an existing branch / existing application

> Make sure the staging branch of acme-site has a running environment.

Branch reused; if an application for `staging` exists it is reused; running → nothing to do; paused → Claude tells you and resumes it (no approval step); undeployed → activation plan with your configuration, with the settings of an existing environment offered for reuse.

## Copy data between environments

> Copy the database and files from main to feature/search in acme-site.

Claude confirms source and target ("the feature/search database will be replaced; its files will be merged with main's"), checks both are running with static files paths, starts a backup of the target (no approval step) and waits for both backup parts to be `SUCCESS`, then shows the sync plan. The target is down while the database is copied. Selective database-only or files-only copies are not available.

## Existing Drupal codebase

> Can ~/src/customer-site be deployed on DevPanel?

`inspect-drupal-source.mjs` report: Drupal version, Composer layout, web root, suggested project type and PHP image, existing `.devpanel` files and their evidence level, other deployment config, risks (credentials, dumps) by path. Claude proposes changes only with evidence and your authorization, then uses the repository workflow. Data migration is a separate, manual step (`docs/MANUAL-DATA-IMPORT.md`).

## Setup check

> Check my DevPanel toolkit setup.

`devpanel_whoami`, `devpanel_list_workspaces`, `devpanel_list_git_owners`, `gh auth status` — read-only, no plans.

## Example execution record

`exec-record.mjs show <record>` after a branch environment run:

```json
{
  "schemaVersion": 1,
  "toolkitVersion": "0.1.0",
  "workflow": "create-branch-environment",
  "status": "completed",
  "createdAt": "2026-10-30T12:00:00.000Z",
  "updatedAt": "2026-10-30T12:09:41.000Z",
  "target": { "workspaceId": "ws-example", "projectId": "proj-example", "repository": "acme/site", "branch": "feature/search", "baseBranch": "develop", "observedSha": "0123456789abcdef0123456789abcdef01234567" },
  "resources": { "branch": { "created": true }, "application": { "id": "app-example", "created": true, "url": "https://feature-search-acme.example.devpanel.app" } },
  "planIds": ["plan-sync-branches-example", "plan-activate-example"],
  "activityIds": ["act-deploy-example"],
  "completedSteps": ["branch created at 0123456", "application created by branch sync", "activated small_2 / devpanel/php:8.3-base", "site check: ready (HTTP 200)"],
  "pending": [],
  "errors": [],
  "notes": ["deployed commit not verifiable via MCP", "MySQL: workspace cluster default (user accepted)"],
  "verification": { "siteStatus": "ready", "httpCode": 200 }
}
```
