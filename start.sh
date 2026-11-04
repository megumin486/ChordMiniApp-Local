#!/usr/bin/env bash
#
# ChordMini — local one-command launcher (Linux / macOS / WSL2)
#
#   ./start.sh                 set up whatever is missing, then start backend + frontend
#   ./start.sh --check         report what is installed / missing; change nothing
#   ./start.sh --setup-only    install and prepare only, start nothing
#   ./start.sh --prod          build the frontend and run it in production mode
#                              (reuses the previous build when sources are unchanged)
#   ./start.sh --prod --rebuild   always rebuild, even if the build looks current
#   ./start.sh --prod --no-build  never build; fail if there is no build yet
#   ./start.sh --no-backend    start only the Next.js frontend
#   ./start.sh --no-frontend   start only the Flask backend
#   ./start.sh --lfs           also download the SongFormer LFS checkpoints
#   ./start.sh --help
#
# Environment overrides:
#   BACKEND_PORT (5001)   FRONTEND_PORT (3000)   PYTHON=/path/to/python3.10
#   BACKEND_LOG/FRONTEND_LOG (default /tmp/chordmini-*.log)   NODE_OPTIONS
#
# Everything runs on this machine: no accounts, no API keys, no outbound calls.
# Requires: bash, git, python3, node + npm.
#
set -u

SCRIPT_PATH="${BASH_SOURCE[0]}"
ROOT="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
BACKEND_DIR="$ROOT/python_backend"
VENV_DIR="$BACKEND_DIR/.venv"
ENV_FILE="$ROOT/.env.local"
ENV_EXAMPLE="$ROOT/.env.example"
FRONTEND_BIN="$ROOT/node_modules/.bin/next"

BACKEND_PORT_OVERRIDE="${BACKEND_PORT:-}"
FRONTEND_PORT_OVERRIDE="${FRONTEND_PORT:-}"
BACKEND_PORT="${BACKEND_PORT:-5001}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_LOG="${BACKEND_LOG:-/tmp/chordmini-backend.log}"
FRONTEND_LOG="${FRONTEND_LOG:-/tmp/chordmini-frontend.log}"

# The model submodules the backend actually loads. (The fourth .gitmodules entry,
# python_backend/beat_transformer_minimal/Beat-Transformer, has no path upstream
# and is intentionally never touched.)
MODEL_SUBMODULES="python_backend/models/Beat-Transformer
python_backend/models/Chord-CNN-LSTM
python_backend/models/ChordMini"

CHECK_ONLY=0
SETUP_ONLY=0
PROD=0
WITH_LFS=0
START_BACKEND=1
START_FRONTEND=1
REBUILD=0
NO_BUILD=0
BACKEND_PID=""
FRONTEND_PID=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

step() { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '  %sok%s  %s\n' "$C_GREEN" "$C_RESET" "$*"; }
skip() { printf '  %s--%s  %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
warn() { printf '  %s!!%s  %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail() { printf '  %sxx%s  %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()  { fail "$*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# --------------------------------------------------------------------------- #
# small helpers                                                                #
# --------------------------------------------------------------------------- #

# Curl first, wget second, python3 last — no dependency on any single one.
http_ok() {
  local url="$1"
  if have curl; then
    curl -fsS -o /dev/null --max-time 3 "$url" >/dev/null 2>&1 && return 0
  elif have wget; then
    wget -q -O /dev/null --timeout=3 "$url" >/dev/null 2>&1 && return 0
  elif have python3; then
    python3 -c 'import sys,urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=3).read(1)
except Exception:
    sys.exit(1)' "$url" >/dev/null 2>&1 && return 0
  fi
  return 1
}

port_in_use() {
  local port="$1"
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then
    return 0
  fi
  if have python3; then
    python3 -c 'import socket,sys
s = socket.socket(); s.settimeout(1)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)' \
      "$port" >/dev/null 2>&1 && return 0
  fi
  return 1
}

wait_for_http() {
  local url="$1" label="$2" timeout="${3:-120}" waited=0
  step "waiting for $label (up to ${timeout}s)"
  while [ "$waited" -lt "$timeout" ]; do
    if http_ok "$url"; then ok "$label is up"; return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  fail "$label did not answer at $url within ${timeout}s"
  return 1
}

py_code() { "$1" -c 'import sys; print("%d%d" % sys.version_info[:2])' 2>/dev/null || true; }

# Echoes the interpreter to use; 3.9–3.11 is preferred (3.10 is what this
# project is developed against, and madmom/numpy==1.26.4 are happiest there).
pick_python() {
  local cand code
  if [ -n "${PYTHON:-}" ]; then
    if have "$PYTHON"; then printf '%s\n' "$PYTHON"; return 0; fi
    fail "PYTHON=$PYTHON was not found on PATH"
    return 1
  fi
  for cand in python3.10 python3.11 python3.9 python3; do
    have "$cand" || continue
    code="$(py_code "$cand")"
    if [ -n "$code" ] && [ "$code" -ge 309 ] && [ "$code" -le 311 ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  if have python3; then
    skip "no Python 3.9-3.11 found; using $(python3 -V 2>&1) (3.10 recommended)"
    printf '%s\n' python3
    return 0
  fi
  return 1
}

env_file_value() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$key=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"//' -e 's/"$//'
}

backend_deps_ok() {
  [ -x "$VENV_DIR/bin/python" ] || return 1
  "$VENV_DIR/bin/python" -c 'import importlib.util as u, sys
mods = ("flask", "madmom", "librosa", "music21")
sys.exit(0 if all(u.find_spec(m) for m in mods) else 1)' >/dev/null 2>&1
}

frontend_deps_ok() { [ -d "$ROOT/node_modules/next" ] && [ -d "$ROOT/node_modules/react" ]; }

missing_submodules() {
  local p
  for p in $MODEL_SUBMODULES; do
    if [ ! -d "$ROOT/$p" ] || [ -z "$(ls -A "$ROOT/$p" 2>/dev/null)" ]; then
      printf '%s\n' "$p"
    fi
  done
}

# --------------------------------------------------------------------------- #
# setup steps                                                                  #
# --------------------------------------------------------------------------- #

ensure_env_file() {
  if [ -f "$ENV_FILE" ]; then
    ok ".env.local present"
    return 0
  fi
  if [ ! -f "$ENV_EXAMPLE" ]; then
    skip ".env.example is missing; not creating .env.local"
    return 1
  fi
  if cp "$ENV_EXAMPLE" "$ENV_FILE"; then
    ok "created .env.local from .env.example"
  else
    skip "could not create .env.local (continuing with built-in defaults)"
  fi
}

ensure_submodules() {
  local missing p
  missing="$(missing_submodules)"
  if [ -z "$missing" ]; then
    ok "model submodules present"
    return 0
  fi
  step "fetching model submodules"
  printf '%s\n' "$missing" | while read -r p; do printf '       %s\n' "$p"; done
  if ! have git; then
    skip "git is not installed — cannot fetch the model submodules"
    return 1
  fi
  # shellcheck disable=SC2086  # word splitting here is the point
  if (cd "$ROOT" && git submodule update --init -- $missing); then
    ok "model submodules initialized"
  else
    skip "git submodule update failed (offline?); model loading may fail later"
  fi
}

ensure_lfs() {
  [ "$WITH_LFS" -eq 1 ] || {
    printf '  %s--%s  SongFormer LFS checkpoints skipped (its UI is disabled in this fork; use --lfs if you need them)\n' "$C_YELLOW" "$C_RESET"
    return 0
  }
  if ! have git-lfs; then
    skip "git-lfs is not installed; skipping --lfs"
    return 1
  fi
  step "downloading SongFormer LFS checkpoints (this is a large download)"
  (cd "$ROOT" && git lfs pull) || skip "git lfs pull failed"
}

ensure_backend_deps() {
  if backend_deps_ok; then
    ok "Python backend dependencies present"
    return 0
  fi
  local py vp tmp
  py="$(pick_python)" || die "Python 3.9+ is required but was not found"
  step "setting up the Python backend environment (this can take a few minutes)"
  if [ ! -x "$VENV_DIR/bin/python" ]; then
    "$py" -m venv "$VENV_DIR" || die "could not create a virtualenv at $VENV_DIR"
    ok "created virtualenv with $py"
  else
    ok "reusing the existing virtualenv"
  fi
  vp="$VENV_DIR/bin/python"
  "$vp" -m pip install --upgrade pip setuptools wheel || die "upgrading pip failed"
  "$vp" -m pip install "Cython>=0.29.0" "numpy==1.26.4" || die "installing Cython/numpy failed"
  "$vp" -m pip install "git+https://github.com/CPJKU/madmom" || die "installing madmom failed"
  if ! "$vp" -m pip install -r "$BACKEND_DIR/requirements.txt"; then
    skip "requirements.txt failed (spleeter pulls TensorFlow and is optional here) — retrying without it"
    tmp="$(mktemp)"
    grep -viE '^(spleeter|typer)' "$BACKEND_DIR/requirements.txt" > "$tmp" || true
    "$vp" -m pip install -r "$tmp" || { rm -f "$tmp"; die "installing backend requirements failed"; }
    rm -f "$tmp"
  fi
  backend_deps_ok || die "backend dependencies are still incomplete"
  ok "backend dependencies installed"
}

ensure_frontend_deps() {
  if frontend_deps_ok; then
    ok "frontend dependencies present"
    return 0
  fi
  have npm || die "npm is required (Node.js >= 20.9) but was not found"
  step "installing frontend dependencies"
  if [ -f "$ROOT/package-lock.json" ]; then
    (cd "$ROOT" && npm ci --no-audit --no-fund) || die "npm ci failed"
  else
    (cd "$ROOT" && npm install --no-audit --no-fund) || die "npm install failed"
  fi
  ok "frontend dependencies installed"
}

# --------------------------------------------------------------------------- #
# starting / stopping                                                          #
# --------------------------------------------------------------------------- #

kill_tree() {
  local pid="$1" sig="${2:-TERM}" child
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  if have pgrep; then
    for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child" "$sig"; done
  fi
  kill -"$sig" "$pid" 2>/dev/null || true
}

cleanup() {
  local rc=$? i=0 alive=1
  trap - EXIT INT TERM
  if [ -n "$BACKEND_PID" ] || [ -n "$FRONTEND_PID" ]; then
    step "shutting down"
    # shellcheck disable=SC2086
    kill_tree "$FRONTEND_PID" TERM
    kill_tree "$BACKEND_PID" TERM
    while [ "$i" -lt 10 ]; do
      alive=0
      if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then alive=1; fi
      if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then alive=1; fi
      [ "$alive" -eq 0 ] && break
      sleep 1
      i=$((i + 1))
    done
    kill_tree "$FRONTEND_PID" KILL
    kill_tree "$BACKEND_PID" KILL
    ok "stopped"
  fi
  exit "$rc"
}

resolve_urls() {
  local file_value
  # An explicit BACKEND_PORT/FRONTEND_PORT wins over .env.local; otherwise the
  # value written in .env.local wins over the built-in default.
  if [ -n "$BACKEND_PORT_OVERRIDE" ]; then
    PYTHON_API_URL="${PYTHON_API_URL:-http://127.0.0.1:$BACKEND_PORT}"
  else
    PYTHON_API_URL="${PYTHON_API_URL:-$(env_file_value PYTHON_API_URL)}"
    PYTHON_API_URL="${PYTHON_API_URL:-http://127.0.0.1:$BACKEND_PORT}"
  fi
  if [ -n "$FRONTEND_PORT_OVERRIDE" ]; then
    NEXT_PUBLIC_BASE_URL="${NEXT_PUBLIC_BASE_URL:-http://127.0.0.1:$FRONTEND_PORT}"
  else
    NEXT_PUBLIC_BASE_URL="${NEXT_PUBLIC_BASE_URL:-$(env_file_value NEXT_PUBLIC_BASE_URL)}"
    NEXT_PUBLIC_BASE_URL="${NEXT_PUBLIC_BASE_URL:-http://127.0.0.1:$FRONTEND_PORT}"
  fi
  SHEETSAGE_API_URL="${SHEETSAGE_API_URL:-$(env_file_value SHEETSAGE_API_URL)}"
  SHEETSAGE_API_URL="${SHEETSAGE_API_URL:-http://localhost:8082}"

  # Exporting a value makes it win over .env.local in Next.js; say so instead of
  # silently disagreeing with the file.
  file_value="$(env_file_value PYTHON_API_URL)"
  [ -n "$file_value" ] && [ "$file_value" != "$PYTHON_API_URL" ] && \
    warn ".env.local has PYTHON_API_URL=$file_value but this run exports $PYTHON_API_URL (the export wins)"
  file_value="$(env_file_value NEXT_PUBLIC_BASE_URL)"
  [ -n "$file_value" ] && [ "$file_value" != "$NEXT_PUBLIC_BASE_URL" ] && \
    warn ".env.local has NEXT_PUBLIC_BASE_URL=$file_value but this run exports $NEXT_PUBLIC_BASE_URL (the export wins)"
  return 0
}

start_backend() {
  step "starting the Flask backend on port $BACKEND_PORT"
  : > "$BACKEND_LOG"
  if have setsid; then
    (cd "$BACKEND_DIR" && exec setsid env PORT="$BACKEND_PORT" \
      "$VENV_DIR/bin/python" app.py) >>"$BACKEND_LOG" 2>&1 &
  else
    (cd "$BACKEND_DIR" && exec env PORT="$BACKEND_PORT" \
      "$VENV_DIR/bin/python" app.py) >>"$BACKEND_LOG" 2>&1 &
  fi
  BACKEND_PID=$!
  printf '       pid %s, log %s\n' "$BACKEND_PID" "$BACKEND_LOG"
}

# True when .next holds a production build made from the current sources, so a
# restart can skip the (slow) rebuild. Anything that is inlined at build time
# counts as an input: NEXT_PUBLIC_* comes from .env.local/.env.example.
frontend_build_is_current() {
  local stamp="$ROOT/.next/BUILD_ID"
  [ -f "$stamp" ] || return 1
  [ -d "$ROOT/.next/server" ] || return 1

  local newer
  newer=$(find "$ROOT/src" "$ROOT/public" "$ENV_FILE" "$ENV_EXAMPLE" \
    "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/next.config.js" \
    "$ROOT/tsconfig.json" "$ROOT/next-env.d.ts" \
    "$ROOT"/tailwind.config* "$ROOT"/postcss.config* \
    -newer "$stamp" -print -quit 2>/dev/null)
  [ -z "$newer" ]
}

start_frontend() {
  if [ "$PROD" -eq 1 ]; then
    if [ "$NO_BUILD" -eq 1 ]; then
      [ -f "$ROOT/.next/BUILD_ID" ] || die "--no-build needs an existing build — run ./start.sh --prod once"
      skip "reusing the existing frontend build (--no-build)"
    elif [ "$REBUILD" -eq 0 ] && frontend_build_is_current; then
      skip "reusing the existing frontend build (sources unchanged — pass --rebuild to force)"
    else
      step "building the frontend (this can take a few minutes)"
      local build_start
      build_start=$(date +%s)
      (cd "$ROOT" && NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" npm run build) \
        || die "npm run build failed"
      ok "frontend build finished in $(( $(date +%s) - build_start ))s"
    fi
    step "starting the Next.js frontend in production mode on port $FRONTEND_PORT"
    if have setsid; then
      (cd "$ROOT" && exec setsid env PYTHON_API_URL="$PYTHON_API_URL" \
        NEXT_PUBLIC_BASE_URL="$NEXT_PUBLIC_BASE_URL" SHEETSAGE_API_URL="$SHEETSAGE_API_URL" \
        "$FRONTEND_BIN" start -p "$FRONTEND_PORT") >>"$FRONTEND_LOG" 2>&1 &
    else
      (cd "$ROOT" && exec env PYTHON_API_URL="$PYTHON_API_URL" \
        NEXT_PUBLIC_BASE_URL="$NEXT_PUBLIC_BASE_URL" SHEETSAGE_API_URL="$SHEETSAGE_API_URL" \
        "$FRONTEND_BIN" start -p "$FRONTEND_PORT") >>"$FRONTEND_LOG" 2>&1 &
    fi
  else
    step "starting the Next.js frontend in dev mode on port $FRONTEND_PORT"
    if have setsid; then
      (cd "$ROOT" && exec setsid env PYTHON_API_URL="$PYTHON_API_URL" \
        NEXT_PUBLIC_BASE_URL="$NEXT_PUBLIC_BASE_URL" \
        "$FRONTEND_BIN" dev --webpack -p "$FRONTEND_PORT") >>"$FRONTEND_LOG" 2>&1 &
    else
      (cd "$ROOT" && exec env PYTHON_API_URL="$PYTHON_API_URL" \
        NEXT_PUBLIC_BASE_URL="$NEXT_PUBLIC_BASE_URL" \
        "$FRONTEND_BIN" dev --webpack -p "$FRONTEND_PORT") >>"$FRONTEND_LOG" 2>&1 &
    fi
  fi
  FRONTEND_PID=$!
  printf '       pid %s, log %s\n' "$FRONTEND_PID" "$FRONTEND_LOG"
}

watch_services() {
  step "ChordMini is running — press Ctrl+C to stop both services"
  printf '\n    app      %s%s%s\n' "$C_BOLD" "$NEXT_PUBLIC_BASE_URL" "$C_RESET"
  printf '    backend  %s%s%s\n\n' "$C_BOLD" "http://127.0.0.1:$BACKEND_PORT" "$C_RESET"
  while :; do
    if [ -n "$BACKEND_PID" ] && ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      fail "the backend exited — see $BACKEND_LOG"
      break
    fi
    if [ -n "$FRONTEND_PID" ] && ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
      fail "the frontend exited — see $FRONTEND_LOG"
      break
    fi
    sleep 2
  done
}

# --------------------------------------------------------------------------- #
# --check                                                                      #
# --------------------------------------------------------------------------- #

report_cmd() {
  local label="$1" cmd="$2"
  if have "$cmd"; then
    printf '  %-12s %s\n' "$label" "$("$cmd" --version 2>&1 | head -n 1)"
  else
    printf '  %-12s %smissing%s\n' "$label" "$C_YELLOW" "$C_RESET"
  fi
}

do_check() {
  local cand code py missing rc=0

  step "toolchain"
  report_cmd python3 python3
  for cand in python3.10 python3.11 python3.9; do
    have "$cand" && printf '  %-12s %s\n' "$cand" "$("$cand" -V 2>&1)"
  done
  report_cmd node node
  report_cmd npm npm
  report_cmd git git
  if have git-lfs; then printf '  %-12s %s\n' git-lfs "$(git lfs version 2>&1 | head -n 1)"
  else printf '  %-12s %snot installed (optional)%s\n' git-lfs "$C_YELLOW" "$C_RESET"; fi

  step "python"
  py="$(pick_python)" || py=""
  if [ -n "$py" ]; then ok "interpreter: $py ($("$py" -V 2>&1))"; else fail "no python3 found"; rc=1; fi
  if [ -x "$VENV_DIR/bin/python" ]; then
    ok "virtualenv: $VENV_DIR"
    if backend_deps_ok; then ok "backend dependencies importable"
    else skip "backend dependencies incomplete (start.sh would install them)"; rc=1; fi
  else
    skip "no virtualenv yet (start.sh would create $VENV_DIR)"; rc=1
  fi

  step "frontend"
  if frontend_deps_ok; then ok "node_modules present"
  else skip "node_modules missing (start.sh would run npm ci)"; rc=1; fi

  step "models"
  missing="$(missing_submodules)"
  if [ -z "$missing" ]; then ok "model submodules present"
  else
    printf '%s\n' "$missing" | while read -r p; do skip "missing submodule: $p"; done
    rc=1
  fi

  step "configuration"
  if [ -f "$ENV_FILE" ]; then ok ".env.local present"
  else skip ".env.local missing (start.sh would copy it from .env.example)"; fi

  step "ports"
  if port_in_use "$BACKEND_PORT"; then skip "port $BACKEND_PORT already in use"; else ok "port $BACKEND_PORT free"; fi
  if port_in_use "$FRONTEND_PORT"; then skip "port $FRONTEND_PORT already in use"; else ok "port $FRONTEND_PORT free"; fi

  printf '\n'
  if [ "$rc" -eq 0 ]; then
    ok "everything is ready — run ./start.sh"
  else
    skip "some pieces are missing — ./start.sh installs them for you"
  fi
  return "$rc"
}

# --------------------------------------------------------------------------- #
# main                                                                         #
# --------------------------------------------------------------------------- #

usage() {
  # Print the leading comment block of this script (stops at the first code line).
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$SCRIPT_PATH"
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --check)       CHECK_ONLY=1 ;;
      --setup-only)  SETUP_ONLY=1 ;;
      --prod)        PROD=1 ;;
      --rebuild)     REBUILD=1 ;;
      --no-build)    NO_BUILD=1 ;;
      --lfs)         WITH_LFS=1 ;;
      --no-backend)  START_BACKEND=0 ;;
      --no-frontend) START_FRONTEND=0 ;;
      -h|--help)     usage; return 0 ;;
      *)             usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done

  if [ "$START_BACKEND" -eq 0 ] && [ "$START_FRONTEND" -eq 0 ] && [ "$SETUP_ONLY" -eq 0 ] && [ "$CHECK_ONLY" -eq 0 ]; then
    die "--no-backend and --no-frontend together would start nothing"
  fi
  [ -f "$BACKEND_DIR/app.py" ] || die "$BACKEND_DIR/app.py is missing — run this from the repository root"
  [ -f "$ROOT/package.json" ] || die "$ROOT/package.json is missing — is this the repository root? (git submodule update --init)"

  resolve_urls

  if [ "$CHECK_ONLY" -eq 1 ]; then
    do_check
    return $?
  fi

  step "ChordMini local launcher"
  printf '       repo %s\n' "$ROOT"
  printf '       app  %s   backend %s\n\n' "$NEXT_PUBLIC_BASE_URL" "$PYTHON_API_URL"

  ensure_env_file
  ensure_submodules
  if [ "$START_BACKEND" -eq 1 ]; then ensure_backend_deps; else skip "backend setup skipped (--no-backend)"; fi
  if [ "$START_FRONTEND" -eq 1 ]; then
    ensure_frontend_deps
    ensure_lfs
  else
    skip "frontend setup skipped (--no-frontend)"
  fi

  if [ "$SETUP_ONLY" -eq 1 ]; then
    printf '\n'
    ok "setup complete — nothing was started"
    return 0
  fi

  if [ "$START_BACKEND" -eq 1 ] && port_in_use "$BACKEND_PORT"; then
    die "port $BACKEND_PORT is already in use — stop that service, or use --no-backend / BACKEND_PORT=<other>"
  fi
  if [ "$START_FRONTEND" -eq 1 ] && port_in_use "$FRONTEND_PORT"; then
    die "port $FRONTEND_PORT is already in use — stop that service, or use --no-frontend / FRONTEND_PORT=<other>"
  fi

  trap cleanup EXIT INT TERM

  if [ "$START_BACKEND" -eq 1 ]; then
    start_backend
    wait_for_http "http://127.0.0.1:$BACKEND_PORT/health" "Flask backend" 120 || exit 1
  fi
  if [ "$START_FRONTEND" -eq 1 ]; then
    start_frontend
    wait_for_http "$NEXT_PUBLIC_BASE_URL/" "Next.js frontend" 180 || exit 1
  fi

  watch_services
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi