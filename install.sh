#!/usr/bin/env bash
# One-command installer for the DevPanel AI Toolkit (macOS, Linux, WSL).
#
#   install.sh [--ref REF] [--dir DIR] [--scope user|project] [--project-dir DIR]
#              [--mcp-url URL] [--mcp-name NAME] [--yes] [--dry-run]
#
# DevPanel MCP URL defaults to https://mcp.devpanel.com/mcp.
#
# Also works piped:  curl -fsSL https://raw.githubusercontent.com/devpanel-developer/devpanel-ai-toolkit/main/install.sh | bash
#
#   1. Checks git, curl, Node.js 18+, GitHub CLI and Claude Code; offers to install what is missing
#      (asks before each install unless --yes).
#   2. Uses this checkout, or clones/updates the toolkit in --dir (default ~/.local/share/dp-ai-toolkit) at --ref (default main).
#   3. Runs scripts/setup.sh: installs the skill, registers DevPanel MCP, then guides the sign-ins
#      that only you can do (Claude Code login, /mcp, gh auth login, GitHub PAT classic).
#
# Never asks for or stores a token or password. Re-run it at any time; finished steps are skipped.
set -uo pipefail

REPO_URL=https://github.com/devpanel-developer/devpanel-ai-toolkit.git
ref=main dir="${XDG_DATA_HOME:-$HOME/.local/share}/dp-ai-toolkit" scope=user project_dir=$PWD
mcp_url='' mcp_name=devpanel yes=0 dry=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --ref) ref=${2:-}; shift 2 ;;
    --dir) dir=${2:-}; shift 2 ;;
    --scope) scope=${2:-}; shift 2 ;;
    --project-dir) project_dir=${2:-}; shift 2 ;;
    --mcp-url) mcp_url=${2:-}; shift 2 ;;
    --mcp-name) mcp_name=${2:-}; shift 2 ;;
    --yes|-y) yes=1; shift ;;
    --dry-run) dry=1; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 64 ;;
  esac
done
[[ $scope == user || $scope == project ]] || { echo "--scope must be user or project" >&2; exit 64; }
[[ -z $mcp_url || $mcp_url == https://* ]] || { echo "--mcp-url must start with https://" >&2; exit 64; }

# Prompts read from the terminal even when the script itself arrives through a pipe.
TTY=/dev/tty
{ : <"$TTY"; } 2>/dev/null || TTY=''
say() { printf '%s\n' "$*"; }
head1() { printf '\n=== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
confirm() {
  [[ $yes -eq 1 ]] && return 0
  [[ -n $TTY ]] || die "no terminal to ask: '$1'. Re-run in a terminal or with --yes."
  local a; read -r -p "$1 [y/N] " a <"$TTY"; [[ $a =~ ^[yY] ]]
}
run() { if [[ $dry -eq 1 ]]; then say "  (dry-run) $*"; else "$@"; fi; }

# --- Platform and package manager -------------------------------------------------------
os=$(uname -s)
[[ $os == Darwin || $os == Linux ]] || die "unsupported system $os. On Windows, run this inside WSL."
SUDO=''; [[ $(id -u) -ne 0 ]] && command -v sudo >/dev/null && SUDO=sudo
pm=''
if [[ $os == Darwin ]]; then command -v brew >/dev/null && pm=brew
elif command -v apt-get >/dev/null; then pm=apt
elif command -v dnf >/dev/null; then pm=dnf
fi
pkg_install() {
  case $pm in
    brew) run brew install "$@" ;;
    apt) run $SUDO apt-get update -qq && run $SUDO apt-get install -y "$@" ;;
    dnf) run $SUDO dnf install -y "$@" ;;
    *) return 1 ;;
  esac
}
apt_candidate_major() { apt-cache policy "$1" 2>/dev/null | sed -n 's/^ *Candidate: *//p' | sed 's/^[0-9]*://' | grep -oE '^[0-9]+' | head -1; }
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

head1 "Step A: prerequisites ($os${pm:+, $pm})"
missing_manual=()

for tool in git curl; do
  command -v $tool >/dev/null && { say "ok  $tool"; continue; }
  if [[ -n $pm ]] && confirm "$tool is missing. Install it with $pm?"; then pkg_install $tool || missing_manual+=("$tool")
  else missing_manual+=("$tool"); fi
done

if [[ $(node_major) -ge 18 ]]; then say "ok  node $(node --version)"
else
  have=$(command -v node >/dev/null && node --version || echo none)
  can=0
  case $pm in
    brew|dnf) can=1 ;;
    apt) [[ $(apt_candidate_major nodejs) -ge 18 ]] 2>/dev/null && can=1 ;;
  esac
  if [[ $can -eq 1 ]] && confirm "Node.js 18+ is required (found: $have). Install it with $pm?"; then
    pkg_install $([[ $pm == brew ]] && echo node || echo nodejs) || missing_manual+=('Node.js 18+')
  else
    missing_manual+=("Node.js 18+ (found: $have; your package manager's version is too old: use https://nodejs.org or nvm)")
  fi
fi

if command -v gh >/dev/null; then say "ok  gh $(gh --version | head -1 | awk '{print $3}')"
else
  can=0
  case $pm in brew|dnf) can=1 ;; apt) [[ -n $(apt_candidate_major gh) ]] && can=1 ;; esac
  if [[ $can -eq 1 ]] && confirm "GitHub CLI (gh) is missing. Install it with $pm?"; then pkg_install gh || missing_manual+=('gh: https://cli.github.com')
  else missing_manual+=('gh: https://cli.github.com'); fi
fi

export PATH="$HOME/.local/bin:$PATH"     # where the Claude Code native installer puts `claude`
if command -v claude >/dev/null; then say "ok  claude $(claude --version 2>/dev/null | head -1)"
elif confirm "Claude Code is missing. Install it with the official installer (curl -fsSL https://claude.ai/install.sh | bash)?"; then
  if [[ $dry -eq 1 ]]; then say "  (dry-run) curl -fsSL https://claude.ai/install.sh | bash"
  else curl -fsSL https://claude.ai/install.sh | bash || missing_manual+=('Claude Code: https://code.claude.com/docs/en/overview'); fi
else missing_manual+=('Claude Code: https://code.claude.com/docs/en/overview'); fi

if [[ ${#missing_manual[@]} -gt 0 ]]; then
  say ''; say 'Install these yourself, then re-run this script:'
  printf '  - %s\n' "${missing_manual[@]}"
  [[ $dry -eq 1 ]] || exit 1
fi

# --- Toolkit source ---------------------------------------------------------------------
head1 'Step B: toolkit source'
self_dir=''
[[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]] && self_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ -n $self_dir && -x $self_dir/installers/install-claude-code.sh ]]; then
  ROOT=$self_dir
  say "Using this checkout: $ROOT ($(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null))"
elif [[ -d $dir/.git ]]; then
  ROOT=$dir
  [[ -z $(git -C "$ROOT" status --porcelain) ]] || die "$ROOT has local changes; commit or remove them, or use --dir."
  say "Updating $ROOT to $ref"
  run git -C "$ROOT" fetch --quiet origin "$ref" || die "cannot fetch $ref"
  run git -C "$ROOT" checkout --quiet FETCH_HEAD || die "cannot check out $ref"
elif [[ -e $dir ]]; then
  die "$dir exists and is not a toolkit checkout; use --dir."
else
  ROOT=$dir
  say "Cloning into $ROOT ($ref)"
  run mkdir -p "$(dirname "$ROOT")"
  run git clone --quiet "$REPO_URL" "$ROOT" || die 'clone failed'
  run git -C "$ROOT" checkout --quiet "$ref" || die "cannot check out $ref"
fi
[[ $dry -eq 1 ]] || say "Toolkit version $(cat "$ROOT/VERSION" 2>/dev/null) at $(git -C "$ROOT" rev-parse --short HEAD)"

# --- Guided setup -----------------------------------------------------------------------
head1 'Step C: install the skill and connect your accounts (scripts/setup.sh)'
args=(--scope "$scope" --project-dir "$project_dir" --mcp-name "$mcp_name")
[[ -n $mcp_url ]] && args+=(--mcp-url "$mcp_url")
if [[ $dry -eq 1 ]]; then say "  (dry-run) $ROOT/scripts/setup.sh ${args[*]}"; exit 0; fi
[[ -n $TTY ]] || die 'setup needs a terminal for the sign-in steps. Re-run in a terminal.'
exec "$ROOT/scripts/setup.sh" "${args[@]}" <"$TTY" >"$TTY" 2>&1
