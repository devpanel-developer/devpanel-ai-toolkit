# Drupal configuration for DevPanel — evidence status

This directory is the canonical location for toolkit-managed Drupal configuration (local project templates, distinct from DevPanel catalog templates used by quickclone).

**No production template is published.** `requirements.json` records what is known, at which evidence level, and what is missing. `inspect-drupal-source.mjs` uses it to report on a customer codebase.

## What is verified

Confirmed DevPanel platform behaviour:

- `.devpanel/config.yml` is read and validated by DevPanel if present; a missing file is accepted.
- Deployments select a run script by name: `re-config.sh` when deploying from Git (the DevPanel MCP's activation default `isFromGit: true`), a database URL or a copied application; `init.sh` otherwise. A catalog may override the name (`runScript`).
- The application environment provides DB connection values to the container (the observed scripts read `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `APP_ROOT`, `WEB_ROOT`).

## What is observed, not verified

`drupal-forge` (023fa358), a Drupal CMS repository maintained by DevPanel, ships:

```text
.devpanel/
├── config.yml
├── init.sh
├── re-config.sh
├── custom_package_installer.sh
├── drupal-settings.php
├── cron_scripts/
└── quickstart/
```

Its scripts are site-specific (Node 18 and gulp installation, PECL extensions, a `drush si` with a fixed admin password, import of `.devpanel/dumps/*.tgz`). They are not suitable as a generic template, and some behaviour (fixed credentials, importing dumps committed to the repository) must not be reproduced for customer sites.

## Missing evidence before a template can be published

1. The deployment playbook contract: where the run script is resolved, its working directory, environment and failure handling.
2. A successfully deployed reference project on DevPanel with a known `.devpanel` layout — e.g. the repository produced by a Drupal CMS quickclone in the user's instance, plus its deploy activity log.
3. Whether DevPanel images provide default scripts when a repository has none.

Once 1–2 are available: add the template files here, set `productionTemplatePublished` to `true`, update each item's `evidence`/`required` in `requirements.json`, and validate by deploying a non-production project.
