#!/bin/bash

hosts_resolver_is_true() {
	case "${1,,}" in
		true|on|1|yes) return 0 ;;
		*) return 1 ;;
	esac
}

configure_hosts_resolver() {
	local output="${1:-/etc/nginx/conf.d/include/resolvers.conf}"
	if ! hosts_resolver_is_true "${ENABLE_HOSTS_RESOLVER:-}"; then
		return 0
	fi
	if hosts_resolver_is_true "${DISABLE_RESOLVER:-}"; then
		echo 'ENABLE_HOSTS_RESOLVER and DISABLE_RESOLVER cannot both be enabled' >&2
		return 1
	fi
	local ipv6=''
	if hosts_resolver_is_true "${DISABLE_IPV6:-}"; then
		ipv6=' ipv6=off'
	fi
	# Redirection preserves the ownership established by upstream prepare.
	printf 'resolver 127.0.0.1:5353%s valid=1s;\n' "$ipv6" > "$output"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	configure_hosts_resolver "$@"
fi
