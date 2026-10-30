# DevPanel project requirements

Verified server-configuration mappings and Drupal source requirements. Machine-readable data: `${CLAUDE_SKILL_DIR}/assets/server-config.json` (server configuration) and `${CLAUDE_SKILL_DIR}/templates/drupal/requirements.json` (Drupal files). Evidence sources are listed in the toolkit's `docs/EVIDENCE.md`.

## 1. Server configuration choices

The user chooses CPU, memory, PHP and MySQL. They map to DevPanel as follows:

| User choice | DevPanel concept | MCP field (activation) | Notes |
|---|---|---|---|
| CPU + memory | One **capacity tier** (CPU and memory are coupled) | `capacity`, and `capacityLimit` | Never offer independent CPU/memory values |
| PHP | **Container image** | `containerImage` | `devpanel/php:<version>-<variant>` or a catalog/custom image |
| MySQL | **Workspace cluster setting** (`dbEngine`/`dbEngineVersion` of the environment) | none | Not selectable or readable per application through MCP |
| Disk | Storage in GiB | `storage` | MCP default 5; can only grow later |
| Paths | App root and web root | `appRoot`, `webRoot` | Stack-specific; always explicit |

### Capacity tiers (CPU/memory)

| Tier | CPU | Memory | Offered by DevPanel's capacity listing |
|---|---|---|---|
| `over_commit` | 0 (burst) | 0 (burst) | yes — DevPanel forces `capacityLimit=large_1` |
| `tiny` | 0.125 | 0.5 GB | yes |
| `micro` | 0.25 | 0.5 GB | yes |
| `micro_x` | 0.25 | 1 GB | yes |
| `small_1` | 0.5 | 1 GB | yes |
| `small_2` | 0.5 | 2 GB | yes (tested Drupal CMS deployment) |
| `medium_1` | 1 | 2 GB | yes |
| `medium_2` | 1 | 4 GB | yes |
| `large_1` | 2 | 4 GB | no — confirm the workspace plan allows it |
| `large_2` | 2 | 8 GB | no — confirm first |
| `xlarge_1` | 4 | 8 GB | no — confirm first |
| `xlarge_2` | 4 | 16 GB | no — confirm first |

Rules:
- If the user states CPU and memory, pick the tier that matches both exactly; if none does, show the two nearest tiers and ask.
- Always pass `capacityLimit` explicitly, normally equal to `capacity`. The MCP default is `micro` and is not flagged by the plan warning, so omitting it can set the limit below the requested tier.
- Drupal sites generally need more than `micro`; `small_2` is a reasonable suggestion, not a default.

### PHP (container image)

`devpanel/php:<version>-base` (also `-secure`, `-advance`; `7.4-apache` exists) for PHP 7.4, 8.0, 8.1, 8.2, 8.3, 8.4, 8.5.

DevPanel's own per-project-type defaults: `drupal10_v2` → `devpanel/php:8.2-base`, `drupal11_v2` → `devpanel/php:8.3-base`, `drupal9_v2` → `8.0-base`, `drupal8_v2` → `7.4-base`, `drupal7_v2` → `8.2-base`, `lamp` → `8.0-base`.

Drupal minimum PHP: Drupal 10 needs ≥ 8.1, Drupal 11 needs ≥ 8.3. Refuse a PHP choice below the minimum of the detected Drupal version; explain and ask again.

A catalog or project may use a non-`devpanel/php` image (the tested Drupal CMS deployment used `drupalforge/drupal_cms:main`; catalogs list `imageTags`/`defaultImageTag` in `devpanel_list_catalogs`). With such an image the PHP version is determined by the image; say so instead of claiming a PHP version.

Do not use the MCP fallback image `devpanel/php:8.3-base-rc`.

### MySQL

The database engine and version belong to the workspace's environment (cluster) in DevPanel and apply to every application in that workspace. There is no MCP parameter to choose it and MCP does not report it.

When the user names a MySQL version:
1. Explain that it is set at the cluster level, not per application.
2. Ask the user to confirm the cluster's MySQL version in the DevPanel UI (workspace → environment), or to pick a workspace on a cluster that provides it.
3. Proceed only after the user confirms the version that will actually be used, or accepts the cluster default. Record that confirmation; never invent an MCP field for it.

Versions DevPanel environments can carry: 5.6, 5.7, 8.0.21, 8.0.36, 8.0.42, 8.4.9 (AWS); 8, 8.4 (DigitalOcean).

### Mapping helper

```bash
node "${CLAUDE_SKILL_DIR}/scripts/server-config.mjs" options --project-type drupal11_v2
node "${CLAUDE_SKILL_DIR}/scripts/server-config.mjs" map --capacity small_2 --php 8.3 --mysql cluster-default \
  --app-root /var/www/html --web-root /var/www/html/web --project-type drupal11_v2 --drupal-major 11
```

`map` prints the activation arguments (`capacity`, `capacityLimit`, `containerImage`, `appRoot`, `webRoot`, `storage`, `copyDatabaseFilesType: ""`, `isFromGit: true`) as JSON. Exit 0 = representable; exit 3 = needs resolution (e.g. a specific MySQL version that only the cluster determines, an unlisted tier without `--allow-unlisted-tier`, PHP below the Drupal minimum); exit 2 = invalid input. Use `--image <image>` for a catalog/custom image instead of `--php`. Pass `--mysql <version> --mysql-confirmed` once the user confirmed the cluster provides that version.

### Reading an existing application as a reference

`devpanel_get_application` returns `webRoot`, `staticFiles`, `originBranch`, status and replicas, but **not** container image, capacity or storage. Use it for paths; ask the user (or have them check the DevPanel UI) for the reference application's image and tier. Do not guess them.

## 2. Drupal source requirements for DevPanel

Evidence status (see `templates/drupal/README.md`):

| Item | Status | Evidence |
|---|---|---|
| `.devpanel/config.yml` (optional; git hook commands) | Platform reads and validates it if present | DevPanel API `validateConfigFile` reads `.devpanel/config.yml` |
| Deploy-time script names `init.sh` / `re-config.sh` | Platform selects these names (`re-config.sh` for deployments from Git) | DevPanel API `runScript` selection |
| Location `.devpanel/<script>` and script contract (env vars `APP_ROOT`, `WEB_ROOT`, `DB_*`) | Observed in a DevPanel-maintained Drupal repository, not verified against the deploy playbook | `drupal-forge/.devpanel/` |
| `.devpanel/drupal-settings.php`, `custom_package_installer.sh`, `cron_scripts/` | Observed only | same |
| Composer layout, `drupal/core` version, web root | Required to choose project type, PHP image and `webRoot` | Inspection |

Consequence: the toolkit does **not** publish a production `.devpanel` template. `deploy-existing-site.md` inspects and reports; adding `.devpanel` files to a customer repository requires a verified reference supplied by the user (for example a DevPanel catalog repository that deploys successfully) and explicit authorization.

### Validation rules for a customer Drupal codebase

Run `node "${CLAUDE_SKILL_DIR}/scripts/inspect-drupal-source.mjs" <path>`; it reports:

1. Composer project: `composer.json` and `composer.lock` present; `drupal/core` (or `drupal/core-recommended`, `drupal/cms`) constraint and locked version.
2. Layout and web root: `extra.drupal-scaffold.locations.web-root` (usually `web/`), else detected `web/`, `docroot/` or repository root. `webRoot` = `<appRoot>/<web-root>` (e.g. `/var/www/html/web`).
3. Drupal major → project type (`drupal10_v2`, `drupal11_v2`, ...) and PHP minimum; PHP platform constraint from `config.platform.php` / `require.php`.
4. Existing `.devpanel/` files and their requirement status.
5. Other deployment configuration (DDEV, Lando, Docker Compose, Pantheon, Platform.sh, Acquia, CI workflows) to preserve.
6. Risks: committed `settings.php` with credentials, `.env` files, database dumps, committed `sites/*/files`, `.devpanel/dumps/`. These are reported by path only; never print their contents and never move data into a template.
