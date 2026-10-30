#!/usr/bin/env bash
# Guided setup for the DevPanel AI Toolkit in the required order. Each step checks the
# current state first and skips what is already done, so it can be re-run to resume.
#
#   setup.sh --scope user|project [--project-dir DIR] [--mcp-url URL] [--mcp-name NAME] [--from-step N]
#
#   1 Claude Code and dependencies      5 GitHub CLI authentication
#   2 Install the skill                 6 GitHub PAT classic saved in DevPanel
#   3 DevPanel MCP server + its login   7 Final diagnostics
#   4 DevPanel identity and workspaces
#
# Run it in your own terminal. Secrets are never typed into this script; the PAT step hands
# over to dp-mcp-helper.mjs (hidden input) or to the DevPanel UI.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
scope='' project_dir=$PWD mcp_url='' mcp_name=devpanel from=1
while [[ $# -gt 0 ]]; do
  case $1 in
    --scope) scope=${2:-}; shift 2 ;;
    --project-dir) project_dir=${2:-}; shift 2 ;;
    --mcp-url) mcp_url=${2:-}; shift 2 ;;
    --mcp-name) mcp_name=${2:-}; shift 2 ;;
    --from-step) from=${2:-1}; shift 2 ;;
    -h|--help) sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done
[[ $scope == user || $scope == project ]] || { echo "--scope user|project is required" >&2; exit 64; }
[[ $from =~ ^[1-7]$ ]] || { echo "--from-step must be 1-7" >&2; exit 64; }
[[ -t 0 && -t 1 ]] || { echo "setup.sh is interactive; run it in a terminal (use scripts/doctor.sh for non-interactive checks)" >&2; exit 64; }
project_dir=$(cd "$project_dir" && pwd)

step() { printf '\n=== Step %s: %s\n' "$1" "$2"; }
ask() { local a; read -r -p "$1 " a; printf '%s' "$a"; }
pause() { read -r -p "${1:-Press Enter to re-check (Ctrl-C to stop and resume later with --from-step $cur)}" _; }
mcp_status() { (cd "$project_dir" && claude mcp get "$mcp_name" 2>/dev/null) | sed -n 's/^ *Status: *//p' | head -1; }
mcp_url_configured() { (cd "$project_dir" && claude mcp get "$mcp_name" 2>/dev/null) | sed -n 's/^ *URL: *//p' | head -1; }
helper_conn() { local u=${mcp_url:-$(mcp_url_configured)}; [[ -n $u ]] && printf '%s' "$u"; }

cur=1
if [[ $from -le 1 ]]; then
  step 1 'Claude Code and dependencies'
  for tool in claude git; do command -v $tool >/dev/null || { echo "Missing $tool. Install it and re-run."; exit 1; }; done
  command -v gh >/dev/null || echo "Note: gh (GitHub CLI) is missing; install it before step 5 (https://cli.github.com)."
  command -v node >/dev/null || echo "Note: Node.js 18+ is missing; skill helpers and the PAT helper need it."
  until claude auth status --json 2>/dev/null | grep -Eq '"loggedIn": *true'; do
    echo "Claude Code is not logged in. In another terminal run: claude   then /login"
    pause
  done
  echo "Claude Code is installed and logged in."
fi

cur=2
if [[ $from -le 2 ]]; then
  step 2 'Install the skill'
  "$ROOT/installers/install-claude-code.sh" --scope "$scope" --project-dir "$project_dir" | sed -n '/^Installed\|^Updated\|^Moved\|^ok\|^warning/p' \
    || { echo "Installation stopped (see the message above). Resolve it and re-run with --from-step 2."; exit 1; }
fi

cur=3
if [[ $from -le 3 ]]; then
  step 3 "DevPanel MCP server \"$mcp_name\""
  if [[ -z $(mcp_url_configured) ]] && ! (cd "$project_dir" && claude mcp get "$mcp_name" >/dev/null 2>&1); then
    [[ -n $mcp_url ]] || mcp_url=$(ask 'DevPanel MCP URL (as provided by DevPanel, e.g. https://mcp.devpanel.com/mcp):')
    "$ROOT/installers/install-claude-code.sh" --scope "$scope" --project-dir "$project_dir" --configure-mcp "$mcp_url" --mcp-name "$mcp_name" >/dev/null \
      || { echo "Could not register the MCP server. Re-run with --from-step 3."; exit 1; }
    echo "Registered \"$mcp_name\" -> $mcp_url"
  fi
  until [[ $(mcp_status) == *Connected* ]]; do
    echo "Status: $(mcp_status)"
    echo "In Claude Code (started in $project_dir), run /mcp, select \"$mcp_name\" and sign in to DevPanel."
    pause
  done
  echo "DevPanel MCP is connected in Claude Code."
fi

cur=4
if [[ $from -le 4 ]]; then
  step 4 'DevPanel identity and workspace access'
  echo "Claude Code's MCP login is not available to this script. Choose how to verify:"
  echo "  c) In Claude Code ask: \"check my DevPanel toolkit setup\" (runs devpanel_whoami and devpanel_list_workspaces)"
  echo "  h) Run the toolkit helper now (opens its own DevPanel MCP sign-in in your browser)"
  case $(ask 'c/h?') in
    h|H) node "$ROOT/scripts/dp-mcp-helper.mjs" check --server-url "$(helper_conn)" || echo "The check reported problems; they may be fixed in steps 5-6." ;;
    *) pause 'Press Enter when Claude reported your DevPanel identity and workspaces.' ;;
  esac
fi

cur=5
if [[ $from -le 5 ]]; then
  step 5 'GitHub CLI authentication (separate from DevPanel)'
  command -v gh >/dev/null || { echo "Install gh (https://cli.github.com) and re-run with --from-step 5."; exit 1; }
  until gh auth status --hostname github.com >/dev/null 2>&1; do
    if [[ $(ask 'gh is not authenticated. Run "gh auth login" now? [y/N]') =~ ^[yY] ]]; then gh auth login --hostname github.com; else pause; fi
  done
  echo "gh authenticated as $(gh api user --jq .login 2>/dev/null)."
fi

cur=6
if [[ $from -le 6 ]]; then
  step 6 'GitHub PAT classic for DevPanel'
  cat <<'EOF'
DevPanel's Git integration needs a GitHub personal access token (classic). gh's own login does not
count, and this script never copies gh credentials. Create the token yourself on GitHub:
  https://github.com/settings/tokens/new?scopes=repo&description=DevPanel
(scope "repo"; authorize it for SSO-enabled organizations you deploy from).
Then save it in DevPanel:
  h) toolkit helper: hidden input, sent directly to devpanel_set_git_token over its own MCP sign-in
  m) manually in the DevPanel UI (the tested baseline)
  s) skip: a working token is already saved
EOF
  case $(ask 'h/m/s?') in
    h|H) node "$ROOT/scripts/dp-mcp-helper.mjs" set-git-token --server-url "$(helper_conn)" || echo "The helper did not complete; you can save the token in the DevPanel UI instead." ;;
    m|M) pause 'Press Enter after saving the token and your GitHub username in the DevPanel UI.' ;;
    *) ;;
  esac
fi

cur=7
step 7 'Final diagnostics'
live=()
[[ $(ask 'Include a live DevPanel check (browser sign-in for the helper)? [y/N]') =~ ^[yY] ]] && live=(--live --server-url "$(helper_conn)")
"$ROOT/scripts/doctor.sh" --project-dir "$project_dir" --mcp-name "$mcp_name" ${live[@]+"${live[@]}"}
