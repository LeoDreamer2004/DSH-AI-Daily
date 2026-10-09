#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
plugin_dir="$(cd -- "$script_dir/.." && pwd)"
harness_dir="${DSH_REPO:-$plugin_dir/../deepseek-harness}"
automatic_refresh="${AI_DAILY_AUTOMATIC_REFRESH:-true}"
profile_name=web
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index++)); do
  if [[ "${arguments[index]}" == "--profile" ]]; then
    profile_name="${arguments[index + 1]:-}"
  elif [[ "${arguments[index]}" == --profile=* ]]; then
    profile_name="${arguments[index]#--profile=}"
  fi
done
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

export AI_DAILY_AUTOMATIC_REFRESH="$automatic_refresh"
printf 'Starting DSH Web with the local plugin enabled.\n'
printf 'Keep this terminal open and press Ctrl+C when you are finished.\n\n'

cd -- "$harness_dir"
# A bundle precedes user settings. Inserting via --patch would shadow saved edits.
node --import tsx/esm apps/cli/src/bin.ts plugin --profile "$profile_name" add "link:$plugin_dir"
node --import tsx/esm apps/cli/src/bin.ts web "$@"
