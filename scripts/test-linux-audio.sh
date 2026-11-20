#!/usr/bin/env bash
set -eu
if [ "${YINGBAN_PRIVATE_DBUS:-}" != 1 ]; then
  export YINGBAN_PRIVATE_DBUS=1
  exec dbus-run-session -- bash "$0"
fi

# Never connect to or modify the user's running audio server.
runtime="$(mktemp -d "${TMPDIR:-/tmp}/yingban-pipewire.XXXXXX")"
export XDG_RUNTIME_DIR="$runtime"
export XDG_STATE_HOME="$runtime/state"
export PULSE_SERVER="unix:$runtime/pulse/native"
export PIPEWIRE_REMOTE=pipewire-0
export PULSE_CLIENTCONFIG="$runtime/client.conf"
printf 'autospawn = no\n' >"$PULSE_CLIENTCONFIG"
unset PULSE_SINK PULSE_SOURCE
pipewire >"$runtime/pipewire.log" 2>&1 & pw_pid=$!
pipewire-pulse >"$runtime/pulse.log" 2>&1 & pulse_pid=$!
wireplumber >"$runtime/wireplumber.log" 2>&1 & wp_pid=$!
cleanup() {
  kill "$wp_pid" "$pulse_pid" "$pw_pid" 2>/dev/null || true
  wait "$wp_pid" "$pulse_pid" "$pw_pid" 2>/dev/null || true
  rm -rf -- "$runtime"
}
trap cleanup EXIT
ready=0
for _ in $(seq 1 80); do
  if pactl info >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  cat "$runtime/pipewire.log" "$runtime/pulse.log" "$runtime/wireplumber.log"
  exit 1
fi
pactl load-module module-null-sink sink_name=yingban_test channels=2 >/dev/null
node tests/linux-audio-live.cjs
