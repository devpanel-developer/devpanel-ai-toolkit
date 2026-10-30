#!/usr/bin/env bash
# HTTP readiness check for a deployed application. A SUCCESS job or
# DEPLOY_APPLICATION_SUCCESS status is not proof the site works; this loads it.
#   check-site.sh URL [--retries N] [--interval SECONDS] [--timeout SECONDS]
# Prints one JSON object. status: ready | auth_protected | install_required |
# error_marker | server_error | not_found | unexpected_status | unreachable.
# Exit: 0 ready, 1 not ready, 2 usage.
set -uo pipefail

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
json_escape() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "${s//$'\n'/ }"; }

url=''; retries=0; interval=20; timeout=30
while [[ $# -gt 0 ]]; do
  case $1 in
    --retries) retries=${2:-}; shift 2 ;;
    --interval) interval=${2:-}; shift 2 ;;
    --timeout) timeout=${2:-}; shift 2 ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [[ -z $url ]] || usage; url=$1; shift ;;
  esac
done
[[ -n $url ]] || usage
for n in "$retries" "$interval" "$timeout"; do [[ $n =~ ^[0-9]+$ ]] || usage; done
[[ $url == http://* || $url == https://* ]] || url="https://$url"
command -v curl >/dev/null 2>&1 || { echo '{"status":"unreachable","error":"curl is not installed"}'; exit 1; }

# Error pages that still come back with a 200 or that explain a 5xx.
MARKERS=(
  'The website encountered an unexpected error'
  'Error establishing a database connection'
  'PDOException'
  'SQLSTATE['
  'Fatal error:'
  'Uncaught Error'
  'Service Unavailable'
  '502 Bad Gateway'
  '504 Gateway Time-out'
  'default backend - 404'
)

body=$(mktemp); trap 'rm -f "$body"' EXIT
attempt=0
while :; do
  attempt=$((attempt + 1))
  : >"$body"
  meta=$(curl -sS -L --max-redirs 5 --max-time "$timeout" -o "$body" -w '%{http_code} %{time_total} %{url_effective}' "$url" 2>&1)
  rc=$?
  marker=''
  if [[ $rc -ne 0 ]]; then
    status=unreachable; code=0; secs=0; final=$url; marker=${meta##*curl: }
  else
    read -r code secs final <<<"$meta"
    sample=$(head -c 262144 "$body" | tr -d '\0')
    for m in "${MARKERS[@]}"; do [[ $sample == *"$m"* ]] && { marker=$m; break; }; done
    if [[ $code == 401 || $code == 403 ]]; then status=auth_protected
    elif [[ $final == *"/core/install.php"* ]]; then status=install_required
    elif [[ -n $marker ]]; then status=error_marker
    elif [[ $code =~ ^[23] ]]; then status=ready
    elif [[ $code =~ ^5 ]]; then status=server_error
    elif [[ $code == 404 ]]; then status=not_found
    else status=unexpected_status
    fi
  fi
  # Terminal outcomes that retrying will not change.
  case $status in ready|auth_protected|install_required) break ;; esac
  [[ $attempt -gt $retries ]] && break
  sleep "$interval"
done

printf '{"url":"%s","status":"%s","httpCode":%s,"finalUrl":"%s","timeSeconds":%s,"marker":%s,"attempts":%s}\n' \
  "$(json_escape "$url")" "$status" "${code:-0}" "$(json_escape "$final")" "${secs:-0}" \
  "$([[ -n $marker ]] && printf '"%s"' "$(json_escape "$marker")" || echo null)" "$attempt"
[[ $status == ready ]]
