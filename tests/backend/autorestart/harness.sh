#!/bin/sh
HARNESS_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$HARNESS_DIR/../../.." && pwd)
AR_STATE=$1
shift

mkdir -p "$AR_STATE/tmp" "$AR_STATE/run"

rewrite() {
    sed -e '/^import /d' \
        -e "s#/tmp/#$AR_STATE/tmp/#g" \
        "$1" >"$AR_STATE/$2.$$.sh"
}
rewrite "$REPO_DIR/src/backend/_helper.sh" helper
rewrite "$REPO_DIR/src/backend/control.sh" control
rewrite "$REPO_DIR/src/backend/cron.sh" cron
. "$AR_STATE/helper.$$.sh"
. "$AR_STATE/control.$$.sh"
. "$AR_STATE/cron.$$.sh"
rm -f "$AR_STATE"/*.$$.sh

ADDON_TITLE="Xray UI"
ADDON_SCRIPT="/jffs/scripts/xrayui"
XRAYUI_CONFIG_FILE="$AR_STATE/xrayui.conf"
XRAY_PIDFILE="$AR_STATE/run/xray.pid"
XRAY_RESTART_LOCKFILE="$AR_STATE/tmp/xrayui.restart.lock"
XRAY_AUTORESTART_STATE_FILE="$AR_STATE/tmp/xrayui.autorestart"

ev() { printf '%s\n' "$*" >>"$AR_STATE/events.log"; }
log_error() { ev "ERROR: $*"; }
log_warn() { ev "WARN: $*"; }
log_info() { :; }
log_ok() { ev "OK: $*"; }
log_notice() { ev "NOTICE: $*"; }
log_debug() { :; }

load_xrayui_config() {
    [ -f "$XRAYUI_CONFIG_FILE" ] && . "$XRAYUI_CONFIG_FILE"
}
get_xray_daemon_pid() {
    [ -n "${AR_PID:-}" ] || return 1
    echo "$AR_PID"
}
restart() { ev "restart"; }
sleep() { ev "sleep $1"; }
cru() { ev "cru $*"; }
date() {
    if [ "$1" = "+%s" ]; then
        echo "${AR_NOW:-1790000000}"
    else
        command date "$@"
    fi
}
which() {
    [ "$1" = "flock" ] && return 0
    command which "$@"
}
flock() {
    [ -z "${AR_LOCK_BUSY:-}" ]
}

for step in "$@"; do
    eval "$step"
    ev "$step rc=$?"
done
