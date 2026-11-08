#!/bin/bash
set -u

hosts_file="${1:-/etc/hosts}"
service_dir="${2:-/run/service/hosts-resolver}"
last_mtime=''
ready=false
warned=false

command -v s6-svc >/dev/null || exit 1
trap 'exit 0' TERM INT

while :; do
	# GNU stat %y includes fractional seconds. Only mtime is compared: changes
	# which deliberately preserve it are outside this monitor's contract.
	if current_mtime=$(stat -L --format='%y' -- "$hosts_file" 2>/dev/null); then
		if [ "$current_mtime" != "$last_mtime" ]; then
			# Signal the currently supervised daemon, never a cached PID. Always
			# reload on monitor startup to cover edits made while it was down.
			if s6-svc -h "$service_dir" 2>/dev/null; then
				last_mtime=$current_mtime
				warned=false
				if [ "$ready" = false ]; then
					printf '\n' >&3
					ready=true
				fi
			elif [ "$warned" = false ]; then
				echo 'Hosts monitor: could not notify dnsmasq; retrying' >&2
				warned=true
			fi
		fi
	elif [ "$warned" = false ]; then
		echo "Hosts monitor: cannot stat $hosts_file; retrying" >&2
		warned=true
	fi
	sleep 1
done
