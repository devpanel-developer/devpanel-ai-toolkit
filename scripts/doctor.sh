#!/usr/bin/env bash
# Diagnostics for the DevPanel AI Toolkit. Read-only; prints no secrets.
#
#   doctor.sh [--project-dir DIR] [--mcp-name NAME] [--repo OWNER/REPO] [--live <helper connection args>]
#
# Reports each prerequisite separately: Claude Code login, skill installation, DevPanel MCP
# configuration/authentication, GitHub CLI authentication, and (with --live, through the
# toolkit's own MCP connection) DevPanel identity, workspaces and the saved PAT classic.
# Example: doctor.sh --repo acme/site --live --server-url https://mcp.devpanel.com/mcp
# Exit: 0 no failures, 1 at least one FAIL.
set -uo pipefail

SKILL=devpanel-project-lifecycle
MANIFEST=.dp-ai-toolkit-manifest
INSTALL_INFO=.dp-ai-toolkit-install.json
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

project_dir=$PWD mcp_name=devpanel repo='' live=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --project-dir) project_dir=${2:-}; shift 2 ;;
    --mcp-name) mcp_name=${2:-}; shift 2 ;;
    --repo) repo=${2:-}; shift 2 ;;
    --live) shift; live=("$@"); [[ ${#live[@]} -gt 0 ]] || { echo "--live needs helper connection arguments" >&2; exit 64; }; break ;;
    -h|--help) sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done

fails=0 warns=0
ok() { printf '  OK    %s\n' "$*"; }
wrn() { printf '  WARN  %s\n' "$*"; warns=$((warns + 1)); }
bad() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
info() { printf '  INFO  %s\n' "$*"; }
section() { printf '\n%s\n' "$*"; }

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
manifest_of() { (cd "$1" && find . -type f ! -name "$MANIFEST" ! -name "$INSTALL_INFO" | LC_ALL=C sort | sed 's|^\./||' | while IFS= read -r f; do sha256 "$f"; done); }

printf 'DevPanel AI Toolkit diagnostics (toolkit %s)\n' "$(tr -d '[:space:]' <"$ROOT/VERSION" 2>/dev/null || echo unknown)"

section '1. Claude Code'
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
  auth=$(claude auth status --json 2>/dev/null || true)
  if grep -Eq '"loggedIn": *true' <<<"$auth"; then ok "logged in ($(sed -n 's/.*"authMethod": *"\([^"]*\)".*/\1/p' <<<"$auth" | head -1))"
  else bad "Claude Code is not logged in (run: claude, then /login)"; fi
else
  bad "Claude Code CLI not found"
fi

section '2. Skill installation'
found=0
for dir in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/$SKILL" "$project_dir/.claude/skills/$SKILL"; do
  [[ -d $dir ]] || continue
  found=1
  ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$dir/$INSTALL_INFO" 2>/dev/null | head -1)
  if [[ ! -f $dir/$MANIFEST ]]; then wrn "$dir exists but was not installed by this toolkit"
  elif diff -q <(manifest_of "$dir") "$dir/$MANIFEST" >/dev/null; then ok "$dir (version ${ver:-unknown}, unmodified)"
  else wrn "$dir (version ${ver:-unknown}) has local modifications"; fi
done
[[ $found -eq 1 ]] || bad "skill not installed (run: installers/install-claude-code.sh --scope user)"

section "3. DevPanel MCP server \"$mcp_name\" (Claude Code configuration)"
if command -v claude >/dev/null 2>&1; then
  # Only these lines are printed: an entry's headers could carry credentials.
  if out=$(cd "$project_dir" && claude mcp get "$mcp_name" 2>/dev/null); then
    url=$(sed -n 's/^ *URL: *//p' <<<"$out" | head -1)
    sc=$(sed -n 's/^ *Scope: *//p' <<<"$out" | head -1)
    status=$(sed -n 's/^ *Status: *//p' <<<"$out" | head -1)
    info "scope: ${sc:-unknown}; url: ${url:-n/a}"
    case $status in
      *Connected*) ok "connected (Claude Code is authenticated to DevPanel MCP)" ;;
      *[Aa]uth*) wrn "configured but not authenticated: in Claude Code run /mcp and sign in to \"$mcp_name\"" ;;
      *) bad "status: ${status:-unknown} (check the URL/command and network)" ;;
    esac
  else
    bad "not configured (installers/install-claude-code.sh --configure-mcp <url>, or claude mcp add)"
  fi
else
  info "skipped (no claude CLI)"
fi

section '4. GitHub CLI (independent of DevPanel)'
if command -v gh >/dev/null 2>&1; then
  if gh auth status --hostname github.com >/dev/null 2>&1; then
    ok "gh authenticated as $(gh api user --jq .login 2>/dev/null || echo unknown)"
    if [[ -n $repo ]]; then
      if acc=$("$ROOT/skills/$SKILL/scripts/gh-branch.sh" access "$repo" 2>/dev/null); then
        if grep -Eq '"push": *true' <<<"$acc"; then ok "$repo readable and writable via gh"; else wrn "$repo readable via gh, but no push permission (branch creation will fail)"; fi
      else bad "$repo not accessible via gh"; fi
    fi
  else
    bad "gh is not authenticated (run: gh auth login)"
  fi
else
  bad "gh not installed (https://cli.github.com)"
fi

section '5. Local tools'
command -v git >/dev/null 2>&1 && ok "$(git --version)" || bad "git not installed"
if command -v node >/dev/null 2>&1 && [[ $(node -p 'process.versions.node.split(".")[0]') -ge 18 ]]; then ok "Node.js $(node --version)"
else wrn "Node.js 18+ not found: skill helpers and dp-mcp-helper.mjs are unavailable"; fi
command -v curl >/dev/null 2>&1 && ok "curl available" || wrn "curl not installed (check-site.sh needs it)"

section '6. DevPanel identity, workspaces and saved PAT classic'
if [[ ${#live[@]} -gt 0 ]]; then
  info "checking through the toolkit's own MCP connection (separate from Claude Code's session)"
  if node "$ROOT/scripts/dp-mcp-helper.mjs" check "${live[@]}" | sed 's/^/        /'; then ok "DevPanel identity, workspaces and Git integration verified"
  else bad "DevPanel check reported problems (see above)"; fi
else
  info "not checked from this shell: Claude Code's MCP login is not available to scripts."
  info "Either ask Claude: \"check my DevPanel toolkit setup\" (devpanel_whoami, devpanel_list_workspaces, devpanel_list_git_owners),"
  info "or re-run with: --live --server-url <DevPanel MCP URL>"
fi

printf '\nSummary: %d failure(s), %d warning(s)\n' "$fails" "$warns"
[[ $fails -eq 0 ]]
