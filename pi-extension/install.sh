#!/usr/bin/env bash
#
# Remote OMP — zero-to-running bootstrap installer
# =================================================
#
#   curl -fsSL https://remote-pi.jacobmoura.work/install.sh | bash
#
# or straight from the repository:
#
#   curl -fsSL https://raw.githubusercontent.com/leoliu0/remote-omp/main/omp-extension/install.sh | bash
#
# What it does (all user-space, NO sudo, idempotent):
#   1. Node       — uses the system Node if it's >= 20.6.0; otherwise installs
#                   it via nvm under ~/.nvm (never touches the system Node).
#                   Only the `remote-omp` CLI and the supervisor run on Node;
#                   omp itself does not need it.
#   2. omp        — if `omp` (oh-my-pi, https://github.com/can1357/oh-my-pi) is
#                   not on PATH, installs it with omp's official installer
#                   (https://omp.sh/install: a standalone binary in
#                   ~/.local/bin). Prefer a package manager? Install omp first
#                   (`brew install can1357/tap/omp`, or
#                   `bun install -g @oh-my-pi/pi-coding-agent`) and re-run.
#   3. remote-omp — installs this plugin into omp (`omp plugin install
#                   remote-omp`). From a checkout of the repository — run the
#                   script from it, or set REMOTE_OMP_FROM_CLONE=<dir> — it
#                   links that checkout instead (`omp plugin link <dir>`; build
#                   it first with `pnpm install && pnpm build`).
#   4. CLI link   — symlinks `remote-omp` and `remote-omp-supervisord` from the
#                   plugin's dist/ into ~/.local/bin.
#   5. Supervisor — installs the per-user service (launchd GUI agent on macOS,
#                   `systemd --user` on Linux) via `remote-omp install`.
#   6. Stops.     — does NOT pair. Prints the next step (pair your phone).
#
# OS support: macOS and native Linux. Windows is asked to use WSL and exits
# cleanly. Re-running is a no-op once everything is in place.
#
# Trust: this script is plain, readable, and asks for no privileges. Read it
# before piping it to bash — same etiquette as nvm / rustup.
#
set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────

MIN_NODE="20.6.0"               # the remote-omp CLI and supervisor run on Node >= 20.6.0
NODE_LTS="22"                   # what we install via nvm when Node is missing
OMP_INSTALL_URL="https://omp.sh/install"   # omp's official installer (macOS / Linux)
PLUGIN_NAME="remote-omp"        # npm package name == omp plugin name
LOCAL_BIN="$HOME/.local/bin"    # where omp's installer and our CLI links land (sudo-free)

# A checkout to link into omp instead of installing the npm package:
# REMOTE_OMP_FROM_CLONE=<dir> (the repo root, or its omp-extension/ folder).
# Running this script from inside a checkout does the same — see find_clone().
FROM_CLONE="${REMOTE_OMP_FROM_CLONE:-}"
CLONE_DIR=""

# Resolved at runtime by resolve_plugin_dir(): omp decides where plugins live
# (normally ~/.omp/plugins/node_modules/remote-omp; PI_CONFIG_DIR / XDG move
# it), so we ask omp instead of hardcoding the path.
PLUGIN_DIR=""

# ── Pretty output ────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YLW=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
fi

step()  { printf '%s\n' "${BLU}${BOLD}==>${RST} ${BOLD}$*${RST}"; }
info()  { printf '%s\n' "    $*"; }
ok()    { printf '%s\n' "    ${GRN}✓${RST} $*"; }
warn()  { printf '%s\n' "    ${YLW}!${RST} $*"; }
die()   { printf '%s\n' "${RED}${BOLD}error:${RST} $*" >&2; exit 1; }

# Versions we actually installed/found, printed in the summary at the end.
SUMMARY=()
record() { SUMMARY+=("$1"); }

# ── 0. OS detection ──────────────────────────────────────────────────────────

detect_os() {
  # Windows shells (Git Bash / MSYS / Cygwin) report MINGW*/MSYS*/CYGWIN*.
  case "${OS:-}" in Windows_NT) echo "windows"; return ;; esac
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)                 echo "macos" ;;
    Linux)                  echo "linux" ;;   # WSL reports Linux — fully supported
    MINGW*|MSYS*|CYGWIN*)   echo "windows" ;;
    *)                      echo "unknown" ;;
  esac
}

OS="$(detect_os)"

if [ "$OS" = "windows" ]; then
  cat <<EOF
${BOLD}Remote OMP${RST}'s installer doesn't run natively on Windows.

Please use ${BOLD}WSL${RST} (Windows Subsystem for Linux) and re-run this
installer inside your WSL shell — it's treated as Linux and works the same:

  ${DIM}# in PowerShell, one time:${RST}
  wsl --install

  ${DIM}# then, inside the WSL (Ubuntu) shell:${RST}
  curl -fsSL https://remote-pi.jacobmoura.work/install.sh | bash

EOF
  exit 0
fi

if [ "$OS" = "unknown" ]; then
  die "unsupported platform '$(uname -s 2>/dev/null)'. Only macOS and Linux are supported."
fi

printf '%s\n' "${BOLD}Remote OMP installer${RST} ${DIM}(${OS}, user-space, no sudo)${RST}"
echo

# ── helpers ──────────────────────────────────────────────────────────────────

# Return 0 if $1 (semver) >= $2 (semver).
version_gte() {
  [ "$1" = "$2" ] && return 0
  # smallest of the two equals $2  ⇒  $1 >= $2
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

ensure_local_bin_on_path() {
  mkdir -p "$LOCAL_BIN"
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) : ;;                  # already there
    *) export PATH="$LOCAL_BIN:$PATH" ;;    # for the rest of this run
  esac
}

# Make the places omp may live visible for the rest of THIS run (the user's
# shell rc is not touched here): omp's installer drops a standalone binary into
# ~/.local/bin, `bun install -g` uses ~/.bun/bin. The latter is only appended,
# so it can never shadow the Node we settled on.
add_omp_dirs_to_path() {
  ensure_local_bin_on_path
  if [ -d "$HOME/.bun/bin" ]; then
    case ":$PATH:" in
      *":$HOME/.bun/bin:"*) : ;;
      *) export PATH="$PATH:$HOME/.bun/bin" ;;
    esac
  fi
}

# Physical (symlink-free) path of directory $1 — empty when it doesn't exist.
physical_dir() { (cd "$1" 2>/dev/null && pwd -P) || true; }

# Append an `export PATH` line to the user's shell rc (idempotent) so the bins
# survive a new shell. We never rewrite existing lines — only add if missing.
persist_path_in_rc() {
  case ":$PATH:" in *":$LOCAL_BIN:"*) : ;; *) return 0 ;; esac
  local rc=""
  case "${SHELL:-}" in
    */zsh)  rc="$HOME/.zshrc" ;;
    */bash) rc="$HOME/.bashrc" ;;
    *)      rc="$HOME/.profile" ;;
  esac
  [ -n "$rc" ] || return 0
  local line='export PATH="$HOME/.local/bin:$PATH"'
  if [ -f "$rc" ] && grep -qF '.local/bin' "$rc"; then
    return 0
  fi
  {
    printf '\n# Added by Remote OMP installer\n%s\n' "$line"
  } >> "$rc"
  warn "added ~/.local/bin to PATH in $rc — open a new shell or 'source $rc'"
}

# ── 1. Node ──────────────────────────────────────────────────────────────────

ensure_node() {
  step "Checking Node.js (need >= $MIN_NODE)"

  if command -v node >/dev/null 2>&1; then
    local have; have="$(node -v 2>/dev/null | sed 's/^v//')"
    if [ -n "$have" ] && version_gte "$have" "$MIN_NODE"; then
      # Classify by path: an nvm Node lives under ~/.nvm, even if it was
      # already on PATH when we started.
      case "$(command -v node)" in
        "$HOME/.nvm/"*) ok "using existing nvm Node v$have"; record "Node:       v$have (nvm)" ;;
        *)              ok "using system Node v$have";       record "Node:       v$have (system)" ;;
      esac
      return 0
    fi
    warn "system Node v${have:-?} is older than $MIN_NODE — installing a private one via nvm"
  else
    info "no Node found — installing a private one via nvm (user-space)"
  fi

  install_node_via_nvm
}

install_node_via_nvm() {
  # nvm is INCOMPATIBLE with npm_config_prefix and aborts if it's set (the
  # user's environment may have it). Clear it before any nvm call.
  unset npm_config_prefix 2>/dev/null || true
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    info "installing nvm into $NVM_DIR"
    # Pinned, well-known nvm installer. Runs entirely in $HOME, no sudo.
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null
  else
    info "nvm already present in $NVM_DIR"
  fi

  # shellcheck disable=SC1091
  \. "$NVM_DIR/nvm.sh"

  if ! nvm ls "$NODE_LTS" >/dev/null 2>&1; then
    info "installing Node $NODE_LTS via nvm"
    nvm install "$NODE_LTS" >/dev/null
  fi
  nvm use "$NODE_LTS" >/dev/null

  command -v node >/dev/null 2>&1 || die "nvm install finished but 'node' is still not on PATH"
  local have; have="$(node -v | sed 's/^v//')"
  version_gte "$have" "$MIN_NODE" || die "installed Node v$have is still < $MIN_NODE"
  ok "installed Node v$have via nvm"
  record "Node:       v$have (nvm)"
}

# ── 2. omp (oh-my-pi) ────────────────────────────────────────────────────────

ensure_omp() {
  step "Checking omp (oh-my-pi)"
  add_omp_dirs_to_path

  if command -v omp >/dev/null 2>&1; then
    local v; v="$(omp --version 2>/dev/null | head -n1 || true)"
    ok "omp already installed (${v:-version unknown}) — skipping"
    record "omp:        ${v:-installed} (pre-existing)"
    return 0
  fi

  # omp's own installer: a prebuilt standalone binary in ~/.local/bin — no sudo,
  # and no Node or bun needed. Prefer to manage omp yourself? Install it first
  # and re-run this script, which then just finds it:
  #   brew install can1357/tap/omp
  #   bun install -g @oh-my-pi/pi-coding-agent
  info "omp not found — installing it with the official installer ($OMP_INSTALL_URL)"
  if ! curl -fsSL "$OMP_INSTALL_URL" | sh; then
    die "omp's installer failed (see above). Install omp yourself, then re-run this script:
      brew install can1357/tap/omp
      bun install -g @oh-my-pi/pi-coding-agent"
  fi

  add_omp_dirs_to_path   # re-resolve PATH: the binary lands in ~/.local/bin (or ~/.bun/bin)
  command -v omp >/dev/null 2>&1 \
    || die "omp was installed but 'omp' is not on PATH (looked in $LOCAL_BIN and ~/.bun/bin)"
  local v; v="$(omp --version 2>/dev/null | head -n1 || true)"
  ok "installed omp (${v:-version unknown})"
  record "omp:        ${v:-installed} ($OMP_INSTALL_URL)"
}

# ── 3. remote-omp plugin ─────────────────────────────────────────────────────

# True when $1 is the extension's package directory (its package.json is named
# remote-omp).
is_extension_dir() {
  [ -f "$1/package.json" ] && grep -q "\"name\": *\"$PLUGIN_NAME\"" "$1/package.json"
}

# Sets CLONE_DIR to a checkout to link instead of installing from npm: from
# REMOTE_OMP_FROM_CLONE (the repo root or its omp-extension/ folder), else the
# folder this script sits in. Under `curl | bash` there is no script file, so
# CLONE_DIR stays empty (= install from npm).
find_clone() {
  local cand src
  if [ -n "$FROM_CLONE" ]; then
    for cand in "$FROM_CLONE" "$FROM_CLONE/omp-extension"; do
      if is_extension_dir "$cand"; then CLONE_DIR="$(physical_dir "$cand")"; return 0; fi
    done
    die "REMOTE_OMP_FROM_CLONE=$FROM_CLONE is not a Remote OMP checkout (expected a package.json named $PLUGIN_NAME there or in omp-extension/)."
  fi
  src="${BASH_SOURCE[0]:-}"
  if [ -n "$src" ] && [ -f "$src" ]; then
    cand="$(physical_dir "$(dirname "$src")")"
    if [ -n "$cand" ] && is_extension_dir "$cand"; then CLONE_DIR="$cand"; fi
  fi
  return 0
}

# Where omp keeps plugin $1 — empty when it isn't installed. Asks omp itself, so
# PI_CONFIG_DIR / XDG overrides are honoured; falls back to the default
# ~/.omp/plugins/node_modules/<name>.
plugin_dir_of() {
  local name="$1" json dir=""
  if json="$(omp plugin list --json 2>/dev/null)"; then
    dir="$(printf '%s' "$json" | node -e '
      let s = "";
      process.stdin.on("data", (d) => { s += d; }).on("end", () => {
        try {
          const hit = (JSON.parse(s).npm || []).find((p) => p && p.name === process.argv[1]);
          if (hit && typeof hit.path === "string") process.stdout.write(hit.path);
        } catch {}
      });
    ' "$name" 2>/dev/null)" || dir=""
  fi
  if [ -z "$dir" ] && [ -f "$HOME/.omp/plugins/node_modules/$name/package.json" ]; then
    dir="$HOME/.omp/plugins/node_modules/$name"
  fi
  printf '%s' "$dir"
}

# Sets PLUGIN_DIR to the installed plugin. Returns 1 unless its compiled entry
# (dist/index.js, the `omp.extensions` target) is there.
resolve_plugin_dir() {
  PLUGIN_DIR="$(plugin_dir_of "$PLUGIN_NAME")"
  [ -n "$PLUGIN_DIR" ] && [ -f "$PLUGIN_DIR/dist/index.js" ]
}

ensure_plugin() {
  step "Installing the $PLUGIN_NAME plugin into omp"

  # The pre-rename plugin registers /remote-pi and the old supervisor; next to
  # this one the two would fight over the relay. Never remove it on the user's
  # behalf — say how.
  local old; old="$(plugin_dir_of remote-pi)"
  if [ -n "$old" ]; then
    warn "the old Remote Pi plugin is still installed in omp ($old)"
    warn "remove it so only one of them loads:  omp plugin uninstall remote-pi"
  fi

  find_clone
  if [ -n "$CLONE_DIR" ]; then
    # From a checkout: omp symlinks the directory into its plugin set, so a
    # rebuild is enough to pick up changes. It must be built first — omp loads
    # dist/index.js.
    if [ ! -f "$CLONE_DIR/dist/index.js" ]; then
      die "$CLONE_DIR is not built (dist/index.js is missing). Build it, then re-run this script:
      cd \"$CLONE_DIR\" && pnpm install && pnpm build"
    fi
    if resolve_plugin_dir && [ "$(physical_dir "$PLUGIN_DIR")" = "$CLONE_DIR" ]; then
      ok "plugin already linked to $CLONE_DIR — skipping"
      record "Plugin:     $PLUGIN_NAME (linked from $CLONE_DIR)"
      return 0
    fi
    info "omp plugin link $CLONE_DIR"
    omp plugin link "$CLONE_DIR" </dev/null >/dev/null \
      || die "'omp plugin link $CLONE_DIR' failed — see the error above."
  else
    if resolve_plugin_dir; then
      ok "plugin already installed ($PLUGIN_DIR) — skipping"
      record "Plugin:     $PLUGIN_NAME (pre-existing)"
      return 0
    fi
    info "omp plugin install $PLUGIN_NAME"
    omp plugin install "$PLUGIN_NAME" </dev/null >/dev/null \
      || die "'omp plugin install $PLUGIN_NAME' failed — see the error above.
    Not published yet? Run this script from a checkout of
    https://github.com/leoliu0/remote-omp (build it first) and it links that instead."
  fi

  if ! resolve_plugin_dir; then
    die "the plugin command succeeded but $PLUGIN_NAME/dist/index.js was not found.
    Looked where 'omp plugin list --json' says, then in ~/.omp/plugins/node_modules/$PLUGIN_NAME.
    'omp plugin doctor' shows what omp thinks is wrong."
  fi
  local v; v="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$PLUGIN_DIR/package.json" 2>/dev/null || true)"
  ok "installed $PLUGIN_NAME plugin${v:+ v$v} → $PLUGIN_DIR"
  record "Plugin:     $PLUGIN_NAME${v:+ v$v}"
}

# ── 4. Link the CLI into ~/.local/bin ────────────────────────────────────────
#
# `omp plugin install` makes the /remote-omp slash command available inside omp,
# but it does NOT put the `remote-omp` CLI on $PATH. We symlink it ourselves (the
# same thing `/remote-omp install` does from inside omp's TUI, which we can't run
# from a headless installer), plus the supervisor binary the service runs. The
# links point into the plugin directory omp reported, so a later `omp plugin
# upgrade` or `omp plugin link` swaps the code underneath without relinking.

link_cli() {
  step "Linking the remote-omp CLI into $LOCAL_BIN"
  mkdir -p "$LOCAL_BIN"
  local name target link
  for name in remote-omp remote-omp-supervisord; do
    case "$name" in
      remote-omp)             target="$PLUGIN_DIR/dist/index.js" ;;
      remote-omp-supervisord) target="$PLUGIN_DIR/dist/bin/supervisord.js" ;;
    esac
    [ -f "$target" ] || die "expected $target — is the plugin built?"
    chmod +x "$target" 2>/dev/null || true   # tsc strips the +x bit; shebang is present

    link="$LOCAL_BIN/$name"
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
      ok "$name already points at the plugin — skipping"
    elif [ -e "$link" ] && [ ! -L "$link" ]; then
      die "$link exists and is not a symlink — move it away, then re-run."
    else
      ln -sf "$target" "$link"
      ok "symlinked $link → $target"
    fi
  done
  record "CLI:        $LOCAL_BIN/remote-omp (+ remote-omp-supervisord)"
}

# ── 5. Supervisor (per-user service) ─────────────────────────────────────────
#
# `remote-omp install` writes a launchd GUI agent (macOS) or `systemd --user`
# unit (Linux) and activates it. It also removes the pre-rename Remote Pi unit /
# label if one is there. It's idempotent (re-running refreshes the unit) and
# never asks for sudo — it only touches per-user paths.

install_supervisor() {
  step "Installing the user supervisor service ($OS)"
  # Run the CLI we just linked, by absolute path: no other `remote-omp` on PATH
  # can win.
  if "$LOCAL_BIN/remote-omp" install </dev/null; then
    ok "supervisor installed and activated"
    record "Supervisor: installed (${OS})"
  else
    warn "supervisor install reported an error — see the output above"
    warn "you can re-run it any time with:  remote-omp install"
    record "Supervisor: FAILED — re-run 'remote-omp install'"
  fi
}

# ── 6. Next steps (no pairing) ───────────────────────────────────────────────

print_next_steps() {
  echo
  printf '%s\n' "${GRN}${BOLD}Remote OMP is installed.${RST} Here's what's on disk:"
  echo
  local entry
  for entry in "${SUMMARY[@]}"; do
    printf '    %s\n' "$entry"
  done
  echo
  printf '%s\n' "${BOLD}Next step — pair your phone:${RST}"
  cat <<EOF

    1. Install the ${BOLD}Remote OMP${RST} app on your phone.
    2. In any terminal, open omp and start Remote OMP:

         ${BOLD}omp${RST}
         ${BOLD}/remote-omp${RST}

       (the first run shows a short setup wizard)
    3. Show the pairing QR and scan it with the app:

         ${BOLD}/remote-omp pair${RST}

    Manage the always-on daemon later with ${BOLD}remote-omp${RST} (now on your PATH).
    Docs: ${DIM}https://remote-pi.jacobmoura.work${RST} · ${DIM}https://github.com/leoliu0/remote-omp${RST}

EOF
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) : ;;
    *) warn "Open a new shell (or 'source' your shell rc) so 'omp' and 'remote-omp' are on PATH." ;;
  esac
}

# ── main ─────────────────────────────────────────────────────────────────────

main() {
  ensure_local_bin_on_path
  ensure_node            # may use nvm — settled before anything runs on Node
  ensure_omp
  ensure_plugin
  link_cli
  install_supervisor
  persist_path_in_rc
  print_next_steps
}

main "$@"
