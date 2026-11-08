#!/bin/bash
set -eu

exec "${DNSMASQ_BIN:-/usr/sbin/dnsmasq}" \
	--keep-in-foreground --conf-file=/dev/null --pid-file= \
	--listen-address=127.0.0.1 --bind-interfaces --port="${3:-5353}" \
	--no-hosts --addn-hosts="${1:-/etc/hosts}" --resolv-file="${2:-/etc/resolv.conf}" \
	--cache-size=0 --no-negcache --local-ttl=1 --log-facility=-
