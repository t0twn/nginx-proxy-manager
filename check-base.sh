#!/bin/bash
set -eu

fail() { echo "Unsupported NPM base image: $*" >&2; exit 1; }

for command in node apt-get bash stat sleep; do
	command -v "$command" >/dev/null || fail "missing $command"
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) process.exit(1)' || fail 'Node 18+ required'
for file in /init /command/with-contenv /command/s6-setuidgid \
	/command/s6-notifyoncheck /command/s6-svc \
	/etc/s6-overlay/s6-rc.d/prepare/type \
	/etc/s6-overlay/s6-rc.d/nginx/type \
	/etc/nginx/nginx.conf; do
	[ -f "$file" ] || fail "missing $file"
done
[ -d /etc/s6-overlay/s6-rc.d/user/contents.d ] || fail 'missing s6 user bundle'
[ -d /etc/nginx/conf.d/include ] || fail 'missing Nginx include directory'
grep -Eq 'include[[:space:]]+/etc/nginx/conf.d/include/resolvers(\[\.\]|\.)conf;' /etc/nginx/nginx.conf \
	|| fail 'Nginx no longer includes the expected resolver file'
