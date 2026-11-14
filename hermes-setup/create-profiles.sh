#!/usr/bin/env bash
# Creates the Venom OS agent team as Hermes profiles: a supervisor (default
# name venom) and the starter specialists you choose from researcher, coder,
# operator, writer (default: all four). Safe to run again. More agents are
# added later with `npm run add-agent`.
# `npm run setup` runs this script (or create-profiles.ps1) for you with the
# values you chose; run it by hand to set the models yourself.
#
# Usage:
#   bash create-profiles.sh --brain-model <MODEL_ID> --brain-provider <PROVIDER> [options]
#
# Options:
#   --supervisor <name>        supervisor profile name (default: venom)
#   --agents <list>            starter specialists to create, comma-separated, any
#                              order (default: researcher,coder,operator,writer)
#   --brain-model <id>         model every agent runs on, as `hermes model` shows it (required)
#   --brain-provider <name>    its provider, as `hermes model` shows it (required)
#   --worker-model <id>        model for the agents' workers (default: the brain model)
#   --worker-provider <name>   its provider (default: the brain provider)
#   --max-workers <n>          workers per agent in parallel (default: 5)
#   --repo-path <path>         Venom OS repository; registers the team connector
#   --clone-from <profile>     profile the new specialists are cloned from
#                              (default: the supervisor; 'none' = empty profiles)
#   --no-alias                 pass --no-alias to `hermes profile create`
#   --browser, --notes-dir, --market <text>   filled into the SOUL templates
#   --log <file>               append the full output (every hermes command and
#                              its output) to this file (default: a new file in
#                              the system temp folder); its path is the last line
#   --show-commands            print the full output on screen too
#   --no-next                  leave out the closing "Next: sign in ..." line
#                              (npm run setup does those checks itself)
#   --dry-run, -n              print the commands only
#
# On screen it prints one line per profile and one for the team connector;
# a failing command and its output are always shown.
#
# For each profile (the supervisor, then the chosen specialists) it:
#   1. creates it with `hermes profile create <name> --description ...`
#      (skipped when `hermes profile show <name>` finds it). The specialists
#      are created with `--clone-from <supervisor>`, so an API key in the
#      supervisor's .env carries over (account sign-ins do not),
#   2. copies souls/<template>.SOUL.md to the profile's SOUL.md, filling in the
#      {{...}} placeholders (the supervisor always uses souls/venom.SOUL.md; an
#      existing, different SOUL.md is kept as SOUL.md.bak-<timestamp>, except
#      in a profile this run has just created),
#   3. sets the brain and worker models with `hermes -p <name> config set`,
#   4. for a specialist, removes a `team` connector copied from the supervisor.
# Then, with --repo-path, it registers the team connector on the supervisor
# (`hermes -p <supervisor> mcp add team ...`), unless `mcp list` already
# shows it. The specialists always exist before that step.
#
# It never touches credentials: sign in with `hermes -p <name> model` yourself.

set -euo pipefail
# Bash 5.2+: keep "&" in a value literal in the ${x//a/b} replacements below.
shopt -u patsub_replacement 2>/dev/null || true

SUPERVISOR='venom'
AGENTS='researcher,coder,operator,writer'
BRAIN_MODEL='<BRAIN_MODEL>'
BRAIN_PROVIDER='<BRAIN_PROVIDER>'
WORKER_MODEL=''
WORKER_PROVIDER=''
MAX_WORKERS=5
REPO_PATH=''
CLONE_FROM=''
NO_ALIAS=0
BROWSER='your default web browser'
NOTES_DIR='~/venom-notes'
MARKET='your own country, in its currency'
DRY_RUN=0
SHOW_COMMANDS=0
NO_NEXT=0
LOG=''

need_value() { [ $# -ge 2 ] || { echo "Option $1 needs a value (try --help)" >&2; exit 64; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    --no-alias) NO_ALIAS=1 ;;
    --show-commands) SHOW_COMMANDS=1 ;;
    --no-next) NO_NEXT=1 ;;
    --supervisor) need_value "$@"; shift; SUPERVISOR="$1" ;;
    --agents) need_value "$@"; shift; AGENTS="$1" ;;
    --brain-model) need_value "$@"; shift; BRAIN_MODEL="$1" ;;
    --brain-provider) need_value "$@"; shift; BRAIN_PROVIDER="$1" ;;
    --worker-model) need_value "$@"; shift; WORKER_MODEL="$1" ;;
    --worker-provider) need_value "$@"; shift; WORKER_PROVIDER="$1" ;;
    --max-workers) need_value "$@"; shift; MAX_WORKERS="$1" ;;
    --repo-path) need_value "$@"; shift; REPO_PATH="$1" ;;
    --clone-from) need_value "$@"; shift; CLONE_FROM="$1" ;;
    --browser) need_value "$@"; shift; BROWSER="$1" ;;
    --notes-dir) need_value "$@"; shift; NOTES_DIR="$1" ;;
    --market) need_value "$@"; shift; MARKET="$1" ;;
    --log)
      need_value "$@"; shift; LOG="$1"
      [ -n "$LOG" ] || { echo "Option --log needs a file name (try --help)" >&2; exit 64; } ;;
    --*=*)
      opt="${1%%=*}"; val="${1#*=}"; shift
      set -- "$opt" "$val" "$@"
      continue ;;
    -h|--help) sed -n '2,52p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done

[ -n "$WORKER_MODEL" ] || WORKER_MODEL="$BRAIN_MODEL"
[ -n "$WORKER_PROVIDER" ] || WORKER_PROVIDER="$BRAIN_PROVIDER"
[[ "$MAX_WORKERS" =~ ^[0-9]+$ ]] || { echo "ERROR: --max-workers must be a number" >&2; exit 64; }

ALL_SPECIALISTS=(researcher coder operator writer)
is_specialist() { case "$1" in researcher|coder|operator|writer) return 0 ;; *) return 1 ;; esac; }

# --agents: a subset of the four, any order, each once, no empty entries.
# They are created in the usual order (researcher, coder, operator, writer).
agent_items=()
IFS=',' read -r -a agent_items <<< "$AGENTS,"
chosen=()
for item in "${agent_items[@]+"${agent_items[@]}"}"; do
  item="${item#"${item%%[![:space:]]*}"}"; item="${item%"${item##*[![:space:]]}"}"
  if [ -z "$item" ]; then
    echo "ERROR: --agents needs one or more of researcher, coder, operator, writer, separated by commas, with no empty entries." >&2
    exit 64
  fi
  if ! is_specialist "$item"; then
    echo "ERROR: --agents: unknown agent '$item'; choose from researcher, coder, operator, writer, separated by commas." >&2
    exit 64
  fi
  for c in "${chosen[@]+"${chosen[@]}"}"; do
    [ "$c" != "$item" ] || { echo "ERROR: --agents: '$item' is listed more than once." >&2; exit 64; }
  done
  chosen+=("$item")
done
if [ ${#chosen[@]} -eq 0 ]; then
  echo "ERROR: --agents needs one or more of researcher, coder, operator, writer, separated by commas, with no empty entries." >&2
  exit 64
fi
SPECIALISTS=()
for s in "${ALL_SPECIALISTS[@]}"; do
  for c in "${chosen[@]}"; do [ "$c" != "$s" ] || SPECIALISTS+=("$s"); done
done

case "$SUPERVISOR" in
  researcher|coder|operator|writer|default|hermes|test|tmp|root|sudo) bad_sup=1 ;;
  *) [[ "$SUPERVISOR" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] && bad_sup=0 || bad_sup=1 ;;
esac
if [ "$bad_sup" -eq 1 ]; then
  echo "ERROR: --supervisor '$SUPERVISOR' is not usable: lowercase letters, digits, - and _, and not one of the specialist names (researcher, coder, operator, writer) or a name Hermes reserves." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOUL_DIR="$SCRIPT_DIR/souls"

PROFILES=("$SUPERVISOR" "${SPECIALISTS[@]}")
describe() {
  case "$1" in
    researcher) echo 'Web research: finds, compares and verifies information, products, prices and sources, and reports with links.' ;;
    coder)      echo 'Software: writes, fixes, reviews and runs code and scripts, and verifies the result works.' ;;
    operator)   echo 'This computer: files and folders, documents, spreadsheets, PDFs, installs and routine tasks.' ;;
    writer)     echo 'Writing: drafts emails, posts, product descriptions, documents and replies. Drafts only, never sends.' ;;
    *)          echo 'Supervisor: plans, delegates to the specialist agents through the team connector, checks their reports and answers the owner.' ;;
  esac
}
soul_template() { if is_specialist "$1"; then echo "$1"; else echo venom; fi; }

is_placeholder() { [ -z "$1" ] || [[ "$1" == \<*\> ]]; }

unset_vars=()
is_placeholder "$BRAIN_MODEL"     && unset_vars+=(--brain-model)
is_placeholder "$BRAIN_PROVIDER"  && unset_vars+=(--brain-provider)
is_placeholder "$WORKER_MODEL"    && unset_vars+=(--worker-model)
is_placeholder "$WORKER_PROVIDER" && unset_vars+=(--worker-provider)
if [ ${#unset_vars[@]} -gt 0 ]; then
  msg="Still placeholders: ${unset_vars[*]}. Pass them as options (model ids and provider names as 'hermes model' shows them), or run 'npm run setup'."
  if [ "$DRY_RUN" -eq 0 ]; then echo "ERROR: $msg" >&2; exit 2; fi
  echo "WARNING: $msg Dry run continues with the placeholders." >&2
fi

resolve_hermes() {
  if [ -n "${HERMES_EXE:-}" ]; then echo "$HERMES_EXE"; return; fi
  if command -v hermes >/dev/null 2>&1; then command -v hermes; return; fi
  if [ -n "${LOCALAPPDATA:-}" ] && [ -x "$LOCALAPPDATA/hermes/bin/hermes.exe" ]; then
    echo "$LOCALAPPDATA/hermes/bin/hermes.exe"; return
  fi
  echo ''
}

HERMES="$(resolve_hermes)"
if [ -z "$HERMES" ]; then
  if [ "$DRY_RUN" -eq 0 ]; then
    echo 'ERROR: Hermes not found. Install it first (see README.md), open a new terminal, or set HERMES_EXE.' >&2
    exit 3
  fi
  HERMES=hermes
fi

# Output: `say` lines always reach the screen; `detail` lines (the commands,
# their output and the file steps, as --show-commands prints them) go to the
# log, and to the screen with --show-commands or --dry-run. A dry run writes
# a log only when --log is given.
[ "$DRY_RUN" -eq 1 ] && SHOW_COMMANDS=1
if [ -z "$LOG" ] && [ "$DRY_RUN" -eq 0 ]; then
  LOG="$(mktemp "${TMPDIR:-/tmp}/venom-create-profiles-XXXXXX")"
fi
if [ -n "$LOG" ]; then
  { : >> "$LOG"; } 2>/dev/null || { echo "ERROR: cannot write the log file $LOG" >&2; exit 64; }
  LOG_SHOWN="$(cygpath -w "$LOG" 2>/dev/null || printf '%s' "$LOG")"
  trap 'echo "Full output: $LOG_SHOWN"' EXIT
fi

to_log() { if [ -n "$LOG" ]; then printf '%s\n' "$1" >> "$LOG"; fi; return 0; }
say() { printf '%s\n' "$1"; to_log "$1"; }
detail() { to_log "$1"; if [ "$SHOW_COMMANDS" -eq 1 ]; then printf '%s\n' "$1"; fi; return 0; }
fail() { to_log "ERROR: $1"; echo "ERROR: $1" >&2; exit "$2"; }

show_cmd() {
  local out='> hermes' a
  for a in "$@"; do
    if [[ "$a" == *[[:space:]]* ]]; then out+=" \"$a\""; else out+=" $a"; fi
  done
  echo "$out"
}

run_hermes() {
  local cmd out rc
  cmd="$(show_cmd "$@")"
  detail "$cmd"
  [ "$DRY_RUN" -eq 1 ] && return 0
  if out="$("$HERMES" "$@" 2>&1)"; then rc=0; else rc=$?; fi
  out="${out//$'\r'/}"
  if [ -n "$out" ]; then detail "$out"; fi
  if [ "$rc" -ne 0 ]; then
    # Quiet mode: the failing command and its output still reach the screen.
    if [ "$SHOW_COMMANDS" -eq 0 ]; then
      printf '%s\n' "$cmd" >&2
      if [ -n "$out" ]; then printf '%s\n' "$out" >&2; fi
    fi
    fail "that command failed with exit code $rc." "$rc"
  fi
  return 0
}

has_team() {
  "$HERMES" -p "$1" mcp list 2>&1 | tr -d '\r' | grep -qE '^[[:space:]]*team[[:space:]]'
}

profile_dir() {
  local path
  path="$("$HERMES" -p "$1" config path 2>/dev/null | tail -n 1 | tr -d '\r')"
  [ -n "$path" ] || { echo "ERROR: could not find the folder of profile '$1' (hermes -p $1 config path)." >&2; return 1; }
  dirname "$path"
}

expand_soul() {
  # Literal replacement (no regex surprises from the values).
  local text
  text="$(cat "$1"; printf x)"; text="${text%x}"
  text="${text//\{\{BRAIN_MODEL\}\}/$BRAIN_MODEL}"
  text="${text//\{\{WORKER_MODEL\}\}/$WORKER_MODEL}"
  text="${text//\{\{MAX_WORKERS\}\}/$MAX_WORKERS}"
  text="${text//\{\{BROWSER\}\}/$BROWSER}"
  text="${text//\{\{NOTES_DIR\}\}/$NOTES_DIR}"
  text="${text//\{\{MARKET\}\}/$MARKET}"
  printf '%s' "$text"
}

create_args() {
  # Prints one argument per line for `hermes profile create`.
  local name="$1" src=''
  if is_specialist "$name"; then
    if [ "$CLONE_FROM" != 'none' ]; then src="${CLONE_FROM:-$SUPERVISOR}"; fi
  elif [ -n "$CLONE_FROM" ] && [ "$CLONE_FROM" != 'none' ] && [ "$CLONE_FROM" != "$name" ]; then
    src="$CLONE_FROM"
  fi
  printf '%s\n' profile create "$name"
  [ -n "$src" ] && printf '%s\n' --clone-from "$src"
  printf '%s\n' --description "$(describe "$name")"
  [ "$NO_ALIAS" -eq 1 ] && printf '%s\n' --no-alias
  return 0
}

join_steps() { local out="$1" s; shift; for s in "$@"; do out+=", $s"; done; printf '%s' "$out"; }

[ "$DRY_RUN" -eq 1 ] && say '# Dry run (--dry-run): nothing is created or changed.'
say "# Supervisor: $SUPERVISOR. Agents: ${SPECIALISTS[*]}. Brain: $BRAIN_PROVIDER/$BRAIN_MODEL. Workers: $WORKER_PROVIDER/$WORKER_MODEL (up to $MAX_WORKERS)."

for name in "${PROFILES[@]}"; do
  detail ''
  detail "## $name"
  steps=()
  cargs=()
  while IFS= read -r line; do cargs+=("$line"); done < <(create_args "$name")

  # 1. Profile
  created=0
  if [ "$DRY_RUN" -eq 1 ]; then
    detail "# skipped if 'hermes profile show $name' succeeds"
    run_hermes "${cargs[@]}"
  elif "$HERMES" profile show "$name" >/dev/null 2>&1; then
    detail "profile '$name' exists, not recreated"
    steps+=('exists')
  else
    run_hermes "${cargs[@]}"
    created=1
    steps+=('created')
  fi

  # 2. SOUL.md
  src="$SOUL_DIR/$(soul_template "$name").SOUL.md"
  [ -f "$src" ] || fail "missing template $src" 4
  if [ "$DRY_RUN" -eq 1 ]; then
    detail "> copy $src -> <folder of 'hermes -p $name config path'>/SOUL.md (placeholders filled, a different existing SOUL.md backed up)"
  else
    dest="$(profile_dir "$name")/SOUL.md"
    tmp="$dest.new"
    expand_soul "$src" > "$tmp"
    if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
      detail 'SOUL.md already up to date'
      mv -f "$tmp" "$dest"
      steps+=('job brief up to date')
    else
      bak=''
      if [ -f "$dest" ] && [ "$created" -eq 0 ]; then
        bak="$dest.bak-$(date +%Y%m%d-%H%M%S)"
        cp -p "$dest" "$bak"
        detail "kept the previous SOUL.md as $bak"
      fi
      mv -f "$tmp" "$dest"
      detail "wrote $dest"
      if [ -n "$bak" ]; then steps+=("job brief updated (previous one kept as ${bak##*/})"); else steps+=('job brief written'); fi
    fi
  fi

  # 3. Models (config set is idempotent)
  run_hermes -p "$name" config set model.default "$BRAIN_MODEL"
  run_hermes -p "$name" config set model.provider "$BRAIN_PROVIDER"
  run_hermes -p "$name" config set delegation.model "$WORKER_MODEL"
  run_hermes -p "$name" config set delegation.provider "$WORKER_PROVIDER"
  run_hermes -p "$name" config set delegation.oneshot_max_children "$MAX_WORKERS"
  steps+=('models set')

  # 4. No team connector on a specialist
  if is_specialist "$name"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      detail "# only if 'hermes -p $name mcp list' lists 'team' (copied from the supervisor)"
      run_hermes -p "$name" mcp remove team
    elif has_team "$name"; then
      run_hermes -p "$name" mcp remove team
      steps+=('copied team connector removed')
    fi
  fi

  [ "$DRY_RUN" -eq 1 ] || say "$name: $(join_steps "${steps[@]}")"
done

# 5. Team connector on the supervisor only, after every specialist exists
detail ''
detail "## team connector ($SUPERVISOR profile)"
if [ -z "$REPO_PATH" ]; then
  detail '# skipped: pass --repo-path <path of the Venom OS repo> to register it'
  [ "$DRY_RUN" -eq 1 ] || say 'team connector: skipped (pass --repo-path <path of the Venom OS repo> to register it)'
else
  server="${REPO_PATH%/}/hermes-mcp/server.mjs"
  server="${server//\\//}"
  if [ "$DRY_RUN" -eq 1 ]; then
    detail "# skipped if 'hermes -p $SUPERVISOR mcp list' already lists 'team'"
    run_hermes -p "$SUPERVISOR" mcp add team --command node --args "$server"
  else
    [ -f "$server" ] || fail "not found: $server" 5
    if has_team "$SUPERVISOR"; then
      detail "'team' already registered on $SUPERVISOR"
      say "team connector: already registered on $SUPERVISOR"
    else
      run_hermes -p "$SUPERVISOR" mcp add team --command node --args "$server"
      say "team connector: registered on $SUPERVISOR"
    fi
  fi
fi

detail ''
[ "$NO_NEXT" -eq 1 ] || say 'Next: sign in to your provider for each profile if needed (hermes -p <name> model), then verify (README.md, "Verify").'
