# Add DevPanel configuration to an existing Drupal site (Composer)

The toolkit does not keep its own copy of the `.devpanel` files. The customer's site pulls them with Composer from the Drupal Forge starter template, pinned to one commit, through `drupal/core-composer-scaffold`. Used by `deploy-existing-site.md` step 4–5.

**Status: unverified.** Built from the starter template's source; not yet run against a deployed DevPanel application. Report it as such until a deployment record exists.

## Source

| | |
|---|---|
| Repository | `drupalforge/starter_template` |
| Pinned commit | `d72d2e9505a8514e0af8f32ae19d6dffcf0a096b` (`main`, 2026-10-29) |
| Package name used in the customer's `composer.json` | `drupalforge/devpanel-starter` (inline package; not on Packagist) |

To move to a newer commit, change **both** the URL and `reference` and bump `version`; Composer caches downloads by version and reference.

## Preconditions (stop and report if not met)

- `inspect-drupal-source.mjs` found a Composer-managed Drupal 10/11 site with `drupal/core-composer-scaffold` in `composer.lock` (Drupal's recommended project has it).
- The web root is **one directory below the project root** (`web/`, `docroot/`). If the web root is the project root, `.devpanel/` would be served publicly and `settings.devpanel.php` would not be found: stop.
- The user authorised changes to `composer.json` and `settings.php` on a named branch (never the default branch without permission).

## Files taken

| Mapped to | Why |
|---|---|
| `.devpanel/re-config.sh` | Run on deployments from Git (the toolkit's activation uses `isFromGit: true`) |
| `.devpanel/settings.devpanel.php` | Database, trusted host, private and config sync paths from DevPanel environment variables |
| `.devpanel/warm` | Cache warm-up called by `re-config.sh` |
| `.devpanel/custom_package_installer.sh` | PHP extensions (APCu, uploadprogress), OPcache JIT, optional cron |
| `.devpanel/config.yml` | Git push hooks; only active when the Git provider is set up to call DevPanel |

Not taken: `init.sh` (runs `composer update` and `drush si`, i.e. can install an empty Drupal over an existing site — open question whether DevPanel needs it for Git deployments), `composer_setup.sh` (the site already has `composer.json`), `create_quickstart.sh` and `init-container.sh` (database/files in the repository or image), `drupal-settings.patch` (replaced by the include below, which does not depend on `settings.php` matching core's default line by line), the template's `.gitignore` (it ignores `composer.json`, `web/` and `config/`).

Scaffold overwrites mapped files on every `composer install`/`update`. Customers who customise one of them exclude it themselves (`"[project-root]/.devpanel/<file>": false` in the root `file-mapping`).

## Changes to the customer's `composer.json`

Replace `web` with the inspector's web root directory if it differs.

```json
{
  "repositories": [
    {
      "type": "package",
      "package": {
        "name": "drupalforge/devpanel-starter",
        "version": "1.0.0",
        "type": "library",
        "dist": {
          "type": "zip",
          "url": "https://github.com/drupalforge/starter_template/archive/d72d2e9505a8514e0af8f32ae19d6dffcf0a096b.zip",
          "reference": "d72d2e9505a8514e0af8f32ae19d6dffcf0a096b"
        },
        "extra": {
          "drupal-scaffold": {
            "file-mapping": {
              "[project-root]/.devpanel/re-config.sh": ".devpanel/re-config.sh",
              "[project-root]/.devpanel/settings.devpanel.php": ".devpanel/settings.devpanel.php",
              "[project-root]/.devpanel/warm": ".devpanel/warm",
              "[project-root]/.devpanel/custom_package_installer.sh": ".devpanel/custom_package_installer.sh",
              "[project-root]/.devpanel/config.yml": ".devpanel/config.yml"
            }
          }
        }
      }
    }
  ],
  "require": {
    "drupalforge/devpanel-starter": "1.0.0"
  },
  "extra": {
    "drupal-scaffold": {
      "allowed-packages": ["drupalforge/devpanel-starter"]
    }
  },
  "scripts": {
    "post-drupal-scaffold-cmd": [
      "chmod 755 .devpanel/re-config.sh .devpanel/custom_package_installer.sh .devpanel/warm",
      "test -f web/sites/default/settings.php || cp web/sites/default/default.settings.php web/sites/default/settings.php",
      "grep -q 'settings.devpanel.php' web/sites/default/settings.php || { chmod u+w web/sites/default web/sites/default/settings.php; cat .devpanel/settings-include.txt >> web/sites/default/settings.php; }"
    ]
  }
}
```

Merge these keys into the existing ones (append to `repositories`, `require`, `allowed-packages` and any existing `post-drupal-scaffold-cmd`); never replace the customer's values. Then `composer update drupalforge/devpanel-starter --with-dependencies` and commit `composer.json`, `composer.lock` and the `.devpanel/` files.

## The `settings.php` include

`.devpanel/settings-include.txt` is the one file the site owns (commit it; the toolkit writes it, scaffold does not touch it):

```php

/**
 * Load DevPanel settings when running on DevPanel.
 */
$devpanel_settings = dirname($app_root) . '/.devpanel/settings.devpanel.php';
if (getenv('DP_APP_ID') !== FALSE && file_exists($devpanel_settings)) {
  include $devpanel_settings;
}
```

- Appended at the **end** of `settings.php`, so on DevPanel its database and trusted-host settings win over anything earlier, including a `settings.local.php` include.
- Guarded by `DP_APP_ID`, which only DevPanel sets: local, DDEV and other hosting are unaffected.
- If `settings.php` is committed, the toolkit appends the block locally and commits it on the branch. If `settings.php` is ignored by Git, the Composer hook creates it from `default.settings.php` and appends the block during the deployment's `composer install`.
- Existing hard-coded database credentials or `trusted_host_patterns` in `settings.php` stay in the file and are overridden on DevPanel; report them (by path, never their values) as a risk.

## Local validation (does not prove DevPanel compatibility)

```bash
composer validate --no-check-publish
composer install --dry-run          # resolves the inline package
ls -l .devpanel/                    # scripts executable
php -l web/sites/default/settings.php
grep -c 'settings.devpanel.php' web/sites/default/settings.php   # exactly 1
```

## To verify on the first real deployment

1. The scaffold step copies the files and the hook leaves the scripts executable (`ls -l .devpanel` in the VS Code terminal).
2. The deployment ran `re-config.sh` (activity log) and the site reaches `install_required` (no data yet) instead of a database connection error.
3. Whether DevPanel needs `init.sh` for Git deployments.

Record the outcome; once all three pass, change the status line at the top of this file and in `templates/drupal/README.md`.
