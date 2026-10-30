#!/usr/bin/env bash
# Installs the devpanel-project-lifecycle skill for Claude Code.
#
#   install-claude-code.sh --scope user|project [--project-dir DIR]
#                          [--configure-mcp URL [--mcp-scope local|user|project] [--mcp-name NAME]]
#                          [--force] [--dry-run] [--uninstall]
#
#   --scope user      ${CLAUDE_CONFIG_DIR:-~/.claude}/skills/devpanel-project-lifecycle
#   --scope project   DIR/.claude/skills/devpanel-project-lifecycle (DIR defaults to the current directory)
#   --configure-mcp   register an HTTP DevPanel MCP server with `claude mcp add` if NAME (default
#                     "devpanel") is not configured yet; an existing entry is never changed
#   --force           replace a modified or foreign skill directory; the old one is kept as a .bak-* copy
#   --dry-run         print what would happen, change nothing
#   --uninstall       remove the installed skill (refuses if files were modified, unless --force)
#
# Re-running with the same or a newer toolkit version updates an unmodified installation in place.
# Installation grants no GitHub or DevPanel access; authentication is a separate step (docs/SETUP.md).
set -euo pipefail

SKILL=devpanel-project-lifecycle
MANIFEST=.dp-ai-toolkit-manifest
INSTALL_INFO=.dp-ai-toolkit-install.json
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(tr -d '[:space:]' <"$REPO_ROOT/VERSION")

usage() { sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-64}"; }
log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

scope='' project_dir=$PWD mcp_url='' mcp_scope='' mcp_name=devpanel force=0 dry=0 uninstall=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --scope) scope=${2:-}; shift 2 ;;
    --project-dir) project_dir=${2:-}; shift 2 ;;
    --configure-mcp) mcp_url=${2:-}; shift 2 ;;
    --mcp-scope) mcp_scope=${2:-}; shift 2 ;;
    --mcp-name) mcp_name=${2:-}; shift 2 ;;
    --force) force=1; shift ;;
    --dry-run) dry=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) usage 0 ;;
    *) warn "unknown option $1"; usage ;;
  esac
done

case $scope in
  user) skills_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"; : "${mcp_scope:=user}" ;;
  project)
    [[ -d $project_dir ]] || die "project directory $project_dir does not exist"
    project_dir=$(cd "$project_dir" && pwd)
    skills_dir="$project_dir/.claude/skills"; : "${mcp_scope:=local}" ;;
  '') warn "--scope is required (user or project)"; usage ;;
  *) die "--scope must be user or project" ;;
esac
case $mcp_scope in local|user|project) ;; *) die "--mcp-scope must be local, user or project" ;; esac
[[ $mcp_name =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid --mcp-name"
target="$skills_dir/$SKILL"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# "<sha256>  <relative path>" for every file except the installer's own bookkeeping files.
manifest_of() {
  (cd "$1" && find . -type f ! -name "$MANIFEST" ! -name "$INSTALL_INFO" | LC_ALL=C sort | sed 's|^\./||' | while IFS= read -r f; do sha256 "$f"; done)
}

# 0 = installed by this toolkit and unmodified, 1 = modified, 2 = not managed by this installer.
state_of() {
  [[ -f $1/$MANIFEST ]] || return 2
  if diff -q <(manifest_of "$1") "$1/$MANIFEST" >/dev/null; then return 0; fi
  return 1
}

changed_files() {
  diff <(LC_ALL=C sort "$1/$MANIFEST") <(manifest_of "$1" | LC_ALL=C sort) | sed -n 's/^[<>] [0-9a-f]\{64\}  //p' | sort -u || true
}

installed_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/$INSTALL_INFO" 2>/dev/null | head -1; }

backup_path() { printf '%s.bak-%s' "$1" "$(date -u +%Y%m%dT%H%M%SZ)"; }

check_deps() {
  local missing=0
  if command -v claude >/dev/null 2>&1; then log "ok    Claude Code $(claude --version 2>/dev/null | head -1)"
  else warn "Claude Code CLI (claude) not found: install it first (https://docs.claude.com/en/docs/claude-code)"; missing=1; fi
  if command -v git >/dev/null 2>&1; then log "ok    $(git --version)"; else warn "git not found (required)"; missing=1; fi
  if command -v gh >/dev/null 2>&1; then log "ok    $(gh --version | head -1)"; else warn "GitHub CLI (gh) not found: branch workflows need it (https://cli.github.com)"; fi
  if command -v node >/dev/null 2>&1; then
    local major; major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [[ $major -ge 18 ]]; then log "ok    Node.js $(node --version)"; else warn "Node.js $(node --version) is older than 18: skill helpers and the PAT helper need 18+"; fi
  else warn "Node.js not found: skill helpers (server-config, exec-record, inspector) and the PAT helper need Node.js 18+"; fi
  command -v curl >/dev/null 2>&1 || warn "curl not found: check-site.sh needs it"
  [[ $missing -eq 0 ]] || die "missing required dependencies"
}

do_uninstall() {
  if [[ ! -e $target ]]; then log "Not installed at $target; nothing to do."; return 0; fi
  local st=0; state_of "$target" || st=$?
  if [[ $st -eq 2 ]]; then
    [[ $force -eq 1 ]] || die "$target was not installed by this toolkit; refusing to remove it (use --force to move it aside)"
  elif [[ $st -eq 1 ]]; then
    warn "modified files in $target:"; changed_files "$target" | sed 's/^/  /' >&2
    [[ $force -eq 1 ]] || die "refusing to remove modified files (use --force to keep a backup and remove)"
  fi
  if [[ $dry -eq 1 ]]; then
    if [[ $st -eq 0 ]]; then log "[dry-run] would remove $target"; else log "[dry-run] would move $target to a .bak-* copy"; fi
    return 0
  fi
  if [[ $st -ne 0 ]]; then local b; b=$(backup_path "$target"); mv "$target" "$b"; log "Moved $target to $b"
  else rm -rf "$target"; log "Removed $target"; fi
  log "MCP configuration was not changed. To remove it: claude mcp remove $mcp_name -s $mcp_scope"
}

stage() {
  local dir=$1
  cp -R "$REPO_ROOT/skills/$SKILL/." "$dir/"
  mkdir -p "$dir/templates"
  cp -R "$REPO_ROOT/templates/." "$dir/templates/"
  cp "$REPO_ROOT/VERSION" "$dir/VERSION"
  chmod +x "$dir"/scripts/*.sh "$dir"/scripts/*.mjs
  manifest_of "$dir" >"$dir/$MANIFEST"
  printf '{\n  "name": "%s",\n  "version": "%s",\n  "scope": "%s",\n  "installedAt": "%s",\n  "source": "%s"\n}\n' \
    "$SKILL" "$VERSION" "$scope" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPO_ROOT" >"$dir/$INSTALL_INFO"
}

do_install() {
  local action=install st=3
  if [[ -e $target ]]; then
    st=0; state_of "$target" || st=$?
    case $st in
      0) action=update ;;
      1) warn "modified files in $target:"; changed_files "$target" | sed 's/^/  /' >&2
         [[ $force -eq 1 ]] || die "local modifications would be overwritten; keep them or re-run with --force (a backup is kept)"
         action=replace ;;
      2) [[ $force -eq 1 ]] || die "$target exists and was not installed by this toolkit; re-run with --force to move it aside"
         action=replace ;;
    esac
  fi
  local from; from=$([[ $st -eq 0 ]] && installed_version "$target" || true)
  if [[ $dry -eq 1 ]]; then
    case $action in
      install) log "[dry-run] would install $SKILL $VERSION to $target" ;;
      update) log "[dry-run] would update $target from ${from:-unknown} to $VERSION" ;;
      replace) log "[dry-run] would move $target to a .bak-* copy and install $VERSION" ;;
    esac
    return 0
  fi
  mkdir -p "$skills_dir"
  STAGING=$(mktemp -d "$skills_dir/.$SKILL.staging.XXXXXX")
  trap 'rm -rf "$STAGING"' EXIT
  local staging=$STAGING
  stage "$staging"
  case $action in
    install) mv "$staging" "$target"; log "Installed $SKILL $VERSION to $target" ;;
    update)
      local old; old=$(mktemp -d "$skills_dir/.$SKILL.old.XXXXXX"); rmdir "$old"
      mv "$target" "$old"; mv "$staging" "$target"; rm -rf "$old"
      log "Updated $target (${from:-unknown} -> $VERSION)" ;;
    replace)
      local b; b=$(backup_path "$target"); mv "$target" "$b"; mv "$staging" "$target"
      log "Moved the previous directory to $b"; log "Installed $SKILL $VERSION to $target" ;;
  esac
  trap - EXIT
}

# Registers the MCP server only when no server of that name exists; never edits an existing entry.
configure_mcp() {
  [[ -n $mcp_url ]] || return 0
  [[ $mcp_url =~ ^https://[^[:space:]]+$ || $mcp_url =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/[^[:space:]]*$ ]] \
    || die "--configure-mcp needs an https:// URL (or http://localhost for local testing)"
  local run_dir=$PWD; [[ $scope == project ]] && run_dir=$project_dir
  local existing rc=0
  existing=$(cd "$run_dir" && claude mcp get "$mcp_name" 2>/dev/null) || rc=$?
  if [[ $rc -eq 0 ]]; then
    local url; url=$(sed -n 's/^ *URL: *//p' <<<"$existing" | head -1)
    if [[ $url == "$mcp_url" ]]; then log "MCP server \"$mcp_name\" already configured for $mcp_url; unchanged."; return 0; fi
    warn "MCP server \"$mcp_name\" already exists${url:+ with URL $url}; not changing it."
    warn "To replace it yourself: claude mcp remove $mcp_name (with its scope), then re-run with --configure-mcp."
    MCP_CONFLICT=1; return 0
  fi
  if [[ $dry -eq 1 ]]; then log "[dry-run] would run: claude mcp add --transport http --scope $mcp_scope $mcp_name $mcp_url"; return 0; fi
  (cd "$run_dir" && claude mcp add --transport http --scope "$mcp_scope" "$mcp_name" "$mcp_url") \
    || die "claude mcp add failed"
  log "Registered MCP server \"$mcp_name\" ($mcp_scope scope). Authenticate it in Claude Code with /mcp."
}

MCP_CONFLICT=0
if [[ $uninstall -eq 1 ]]; then do_uninstall; exit 0; fi
check_deps
do_install
configure_mcp
cat <<EOF

Next steps (docs/SETUP.md):
  1. In Claude Code, run /mcp and authenticate the "$mcp_name" server (DevPanel login).
  2. Ask Claude: "check my DevPanel toolkit setup" (runs devpanel_whoami and workspace checks).
  3. gh auth login            (GitHub CLI, separate from DevPanel)
  4. Save a GitHub PAT classic in DevPanel: $REPO_ROOT/scripts/dp-mcp-helper.mjs set-git-token (own terminal) or the DevPanel UI.
  5. $REPO_ROOT/scripts/doctor.sh
EOF
[[ $MCP_CONFLICT -eq 0 ]] || exit 1
