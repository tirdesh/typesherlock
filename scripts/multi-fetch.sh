#!/usr/bin/env bash
# multi-fetch.sh — fetch several URLs and combine their JSON bodies into one
# array on stdout, in exactly the shape typesherlock treats as multiple
# samples to merge. Wraps the real system `curl`; this script has no HTTP
# logic of its own beyond calling curl once per URL.
#
# Usage (full URLs, one per call):
#   multi-fetch.sh <url> [url...] | typesherlock --name User --zod
#
# Usage (template with a {} placeholder, when only one part varies):
#   multi-fetch.sh "https://api.example.com/users/{}" 1 2 999 | typesherlock --name User
#
# Extra curl flags (auth headers, etc.) can be set via CURL_ARGS, e.g.:
#   CURL_ARGS='-H "Authorization: Bearer xyz"' multi-fetch.sh url1 url2

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: multi-fetch.sh <url> [url...]" >&2
  echo "       multi-fetch.sh <template-with-{}> <value> [value...]" >&2
  echo "Fetches each URL and prints a JSON array of the responses on stdout." >&2
  exit 1
fi

urls=()
if [[ "$1" == *"{}"* ]]; then
  template="$1"
  shift
  if [ "$#" -eq 0 ]; then
    echo "multi-fetch.sh: template given but no values to substitute into it" >&2
    exit 1
  fi
  for value in "$@"; do
    urls+=("${template//\{\}/$value}")
  done
else
  urls=("$@")
fi

printf "["
first=true
for url in "${urls[@]}"; do
  if [ "$first" = true ]; then
    first=false
  else
    printf ","
  fi
  # shellcheck disable=SC2086
  curl -sS --fail ${CURL_ARGS:-} "$url"
done
printf "]\n"
