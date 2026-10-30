#!/usr/bin/env bash
# Repository/branch helper on top of the GitHub CLI.
#   gh-branch.sh access       OWNER/REPO                 repository visibility and push permission
#   gh-branch.sh lookup       OWNER/REPO BRANCH          exact branch lookup (never a limited listing)
#   gh-branch.sh resolve-base OWNER/REPO BASE            base branch -> commit SHA
#   gh-branch.sh create       OWNER/REPO BRANCH SHA      create refs/heads/BRANCH at SHA; never forces
# Prints one JSON object on stdout. Exit: 0 ok, 1 branch not found, 2 error, 64 usage.
set -uo pipefail

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 64; }
fail() { printf '{"error":"%s"}\n' "$(json_escape "$1")"; echo "error: $1" >&2; exit 2; }
json_escape() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "${s//$'\n'/ }"; }

# Percent-encode a ref name for a URL path, keeping "/" separators.
urlenc() {
  local s=$1 out='' c i
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in [A-Za-z0-9._~/-]) out+=$c ;; *) out+=$(printf '%%%02X' "'$c") ;; esac
  done
  printf '%s' "$out"
}

valid_repo() { [[ $1 =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "invalid repository \"$1\" (expected OWNER/REPO)"; }
valid_branch() { git check-ref-format --branch "$1" >/dev/null 2>&1 || fail "invalid branch name \"$1\""; }

command -v gh >/dev/null 2>&1 || fail "GitHub CLI (gh) is not installed"

# Runs gh api; stdout -> $API_OUT, stderr -> $API_ERR, returns gh's exit code.
api() {
  local errf; errf=$(mktemp)
  API_OUT=$(gh api "$@" 2>"$errf"); local rc=$?
  API_ERR=$(<"$errf"); rm -f "$errf"
  return $rc
}

repo_access() { # sets REPO_JSON or fails
  if ! api "repos/$1" --jq '{full_name: .full_name, private: .private, default_branch: .default_branch, push: (.permissions.push // false), admin: (.permissions.admin // false)}'; then
    case $API_ERR in
      *"HTTP 404"*) fail "repository $1 not found or not accessible with the current gh credentials" ;;
      *"HTTP 401"*) fail "gh is not authenticated (run: gh auth login)" ;;
      *) fail "cannot read repository $1: ${API_ERR:-unknown gh error}" ;;
    esac
  fi
  REPO_JSON=$API_OUT
}

# Exact ref lookup. Sets BRANCH_SHA; returns 0 found, 1 absent; fails on other errors.
branch_sha() {
  BRANCH_SHA=''
  if api "repos/$1/git/ref/heads/$(urlenc "$2")" --jq '.object.sha'; then
    BRANCH_SHA=$API_OUT
    [[ $BRANCH_SHA =~ ^[0-9a-f]{40}$ ]] || fail "unexpected response looking up branch $2"
    return 0
  fi
  case $API_ERR in
    *"HTTP 404"*) return 1 ;;
    *"HTTP 409"*) fail "repository $1 is empty (no commits)" ;;
    *) fail "cannot look up branch $2 in $1: ${API_ERR:-unknown gh error}" ;;
  esac
}

cmd=${1:-}; shift || true
case $cmd in
  access)
    [[ $# -eq 1 ]] || usage; valid_repo "$1"
    repo_access "$1"; printf '%s\n' "$REPO_JSON" ;;

  lookup)
    [[ $# -eq 2 ]] || usage; valid_repo "$1"; valid_branch "$2"
    repo_access "$1"
    if branch_sha "$1" "$2"; then
      printf '{"exists":true,"branch":"%s","sha":"%s"}\n' "$(json_escape "$2")" "$BRANCH_SHA"
    else
      printf '{"exists":false,"branch":"%s"}\n' "$(json_escape "$2")"; exit 1
    fi ;;

  resolve-base)
    [[ $# -eq 2 ]] || usage; valid_repo "$1"; valid_branch "$2"
    repo_access "$1"
    if branch_sha "$1" "$2"; then
      printf '{"base":"%s","sha":"%s"}\n' "$(json_escape "$2")" "$BRANCH_SHA"
    else
      printf '{"base":"%s","exists":false}\n' "$(json_escape "$2")"; echo "error: base branch $2 does not exist in $1" >&2; exit 1
    fi ;;

  create)
    [[ $# -eq 3 ]] || usage; valid_repo "$1"; valid_branch "$2"
    [[ $3 =~ ^[0-9a-f]{40}$ ]] || fail "base must be a full 40-character commit SHA (resolve it with resolve-base first)"
    repo_access "$1"
    [[ $REPO_JSON =~ \"push\":[[:space:]]*true ]] || fail "the gh account has no push permission on $1"
    if branch_sha "$1" "$2"; then
      # Already there: reuse, never reset.
      printf '{"created":false,"exists":true,"branch":"%s","sha":"%s","matchesBase":%s}\n' \
        "$(json_escape "$2")" "$BRANCH_SHA" "$([[ $BRANCH_SHA == "$3" ]] && echo true || echo false)"
      exit 0
    fi
    if ! api -X POST "repos/$1/git/refs" -f "ref=refs/heads/$2" -f "sha=$3" --jq '.object.sha'; then
      if [[ $API_ERR == *"Reference already exists"* ]] && branch_sha "$1" "$2"; then
        # Created concurrently by someone else: report the actual state.
        printf '{"created":false,"exists":true,"branch":"%s","sha":"%s","matchesBase":%s}\n' \
          "$(json_escape "$2")" "$BRANCH_SHA" "$([[ $BRANCH_SHA == "$3" ]] && echo true || echo false)"
        exit 0
      fi
      fail "branch creation failed: ${API_ERR:-unknown gh error}"
    fi
    branch_sha "$1" "$2" || fail "branch $2 was not readable after creation"
    [[ $BRANCH_SHA == "$3" ]] || fail "branch $2 reads back at $BRANCH_SHA, expected $3"
    printf '{"created":true,"exists":true,"branch":"%s","sha":"%s"}\n' "$(json_escape "$2")" "$BRANCH_SHA" ;;

  *) usage ;;
esac
