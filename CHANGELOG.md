# Changelog

Tags follow `VERSION` (`v<version>`). Install a specific version with `install.sh --ref v<version>`.

## 0.2.0 — 2026-11-02

Existing Drupal sites and one-command installation.

- **Existing Drupal sites:** `.devpanel` files are added to the customer's site with Composer from `drupalforge/starter_template` pinned at `d72d2e9`, plus a `DP_APP_ID`-guarded `settings.php` include of `settings.devpanel.php` (`references/add-devpanel-config.md`). Verified locally; DevPanel deployment behaviour (`re-config.sh`, need for `init.sh`) not yet verified.
- **Database and files:** imported manually by a person in the application's VS Code terminal (`docs/MANUAL-DATA-IMPORT.md`); never through Git, images or the Claude conversation. The skill checks application storage and verifies the site afterwards.
- **`install.sh`:** one command (also `curl … | bash`) that checks and offers to install git, curl, Node.js 18+, gh and Claude Code, clones or updates the toolkit, and runs the guided setup.
- **DevPanel MCP:** `https://mcp.devpanel.com/mcp` is the default; setup offers to replace a `devpanel` entry that points elsewhere (asks first).
- Docs: real MCP URL instead of placeholders; README install and update sections no longer refer to a missing tag.

## 0.1.0 — 2026-10-30

First release: create projects from catalog templates or GitHub repositories, branch environments, environment data sync, Drupal source inspection, plan approval protocol, guided setup and diagnostics.
