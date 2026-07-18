#!/usr/bin/env bash

set -euo pipefail

readonly version="8.30.1"
readonly archive="gitleaks_${version}_linux_x64.tar.gz"
readonly checksum="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
readonly download_url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}"

temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT

curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --output "$temporary/$archive" \
  "$download_url"
printf '%s  %s\n' "$checksum" "$temporary/$archive" | sha256sum --check --strict >&2
tar -xzf "$temporary/$archive" -C "$temporary" gitleaks

install_directory="${RUNNER_TEMP:-/tmp}/gitleaks-${version}/bin"
mkdir -p -- "$install_directory"
install -m 0755 "$temporary/gitleaks" "$install_directory/gitleaks"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$install_directory" >> "$GITHUB_PATH"
else
  printf '%s\n' "$install_directory"
fi
