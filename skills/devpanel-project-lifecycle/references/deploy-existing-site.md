# Prepare an existing customer Drupal site for DevPanel

Inspect the customer's Drupal source, determine what DevPanel needs, add only verified and authorized configuration, then reuse `create-project-from-repository.md`. Database and files migration is separate and currently has no verified import mechanism.

## Evidence status (read first)

The toolkit has **no verified production `.devpanel` template** (see `devpanel-project-requirements.md` §2 and `templates/drupal/README.md`). Verified from DevPanel's API source: DevPanel reads and validates `.devpanel/config.yml` if present, and selects deploy scripts named `init.sh` / `re-config.sh` (the latter for deployments from Git). Not verified: the script location and contract used by the deployment playbook, and whether the repository must ship those scripts or the image provides them.

Therefore:
- Do not create `.devpanel/` files from memory or from the observed example as if they were requirements.
- The default way to add them is `add-devpanel-config.md`: Composer pulls them from the Drupal Forge starter template at a pinned commit, plus one `settings.php` include. Say that this setup is not yet verified by a deployment.
- If the user supplies another verified reference (a repository/catalog that deploys successfully on their DevPanel), you may compare against it instead, with authorization.

## Procedure

1. **Locate the source.** A local path the user names, or a clone of their repository (`gh repo clone`). Work on a branch, never directly on the customer's default branch without permission.
2. **Inspect (read-only):**
   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/inspect-drupal-source.mjs" <path>
   ```
   Review: Composer project and lock file, `drupal/core` version, Drupal major, PHP constraint, web root, suggested project type and DevPanel PHP image, existing `.devpanel/` files, other deployment configuration, and risk findings.
3. **Stop conditions** — report and ask before going further:
   - No `composer.json` / non-Composer (tarball) Drupal, Drupal 7 or older, or unrecognised layout: outside the supported scope of this toolkit.
   - Risk findings (committed credentials in `settings.php`, `.env`, SQL dumps, `sites/*/files` in Git, `.devpanel/dumps/`): tell the user which paths; never print contents; never copy them anywhere.
   - Locked `drupal/core` requires a PHP version that no `devpanel/php` image offers.
4. **Present the plan of changes**: which files would be added or changed and why, with evidence level for each. The DevPanel configuration changes are those in `add-devpanel-config.md` (`composer.json`, `composer.lock`, `.devpanel/`, `settings.php` include). Existing customer files (`settings.php`, existing `.devpanel/`, CI, DDEV/Lando config) are preserved; changing any of them requires the user's explicit authorization for that file. Nothing is overwritten by default.
5. **Apply authorized changes** on a branch, commit with a descriptive message, and push only after the user confirms the target repository and branch. Report the commit SHA.
6. **Validate locally** what can be validated: re-run the inspector; `composer validate --no-check-publish` if Composer is available; `bash -n` on any added shell scripts. Say clearly that local checks do not prove DevPanel compatibility.
7. **Deploy** with `create-project-from-repository.md`, using the inspector's web root, project type and PHP suggestion as the starting point for the user's server configuration choice.
8. **Verify** (`execution-and-verification.md` §5). A fresh deployment of existing source typically shows `install_required` or a database error because the customer's data is not there.

## Data migration (separate)

Deploying source does not migrate the site's database or files. The DevPanel MCP documents no upload/import of a local database dump or files archive; backup download and restore apply only to backups the application itself made. Report this as outstanding work. Do not invent an import path (for example committing dumps into the repository for a deploy script to import).
