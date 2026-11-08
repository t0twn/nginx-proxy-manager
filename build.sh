#!/bin/bash
set -euo pipefail

extension_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
args=(--load --build-arg "NPM_BASE=${NPM_BASE:-jc21/nginx-proxy-manager:latest}"
	-t "${NPM_HOSTS_IMAGE:-npm-hosts:local}")
if [ "${PULL_BASE:-true}" = 'true' ]; then
	args+=(--pull)
fi
if [ -n "${PLATFORM:-}" ]; then
	args+=(--platform "$PLATFORM")
fi
docker buildx build "${args[@]}" "$@" "$extension_dir"
