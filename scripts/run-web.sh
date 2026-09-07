#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
plugin_dir="$(cd -- "$script_dir/.." && pwd)"
harness_dir="${DSH_REPO:-$plugin_dir/../deepseek-harness}"
automatic_refresh="${AI_DAILY_AUTOMATIC_REFRESH:-true}"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/dsh-plugin-web.XXXXXX")"
patch_file="$temporary_dir/cordis.patch.yml"

cleanup() {
  if [[ "$temporary_dir" == "${TMPDIR:-/tmp}/dsh-plugin-web."* ]]; then
    rm -rf -- "$temporary_dir"
  fi
}

trap cleanup EXIT

if [[ ! -f "$harness_dir/package.json" || ! -f "$harness_dir/apps/cli/src/bin.ts" ]]; then
  printf 'Error: DeepSeek Harness source repository not found at: %s\n' "$harness_dir" >&2
  printf 'Set DSH_REPO=/absolute/path/to/deepseek-harness and try again.\n' >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  printf 'Error: pnpm was not found on PATH.\n' >&2
  exit 1
fi

if [[ "$automatic_refresh" != "true" && "$automatic_refresh" != "false" ]]; then
  printf 'Error: AI_DAILY_AUTOMATIC_REFRESH must be true or false.\n' >&2
  exit 1
fi

plugin_entry="$(node -p 'JSON.stringify(process.argv[1])' "$plugin_dir/lib/index.js")"
printf '%s\n' \
  '- id: web-fetch-http' \
  '  config:' \
  '    maxResponseBytes: 5000000' \
  '    maxBodyChars: 1000000' \
  '' \
  '- insert:' \
  '    - id: local-ai-daily' \
  "      name: $plugin_entry" \
  '      config:' \
  "        automaticRefresh: $automatic_refresh" \
  >"$patch_file"

printf 'Starting DSH Web with the local plugin enabled.\n'
printf 'Keep this terminal open and press Ctrl+C when you are finished.\n\n'

cd -- "$harness_dir"
pnpm dsh web --patch "$patch_file" "$@"
