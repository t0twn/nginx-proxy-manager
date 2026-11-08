#!/usr/bin/env python3
"""Opt-in diagnostic of dnsmasq's default /etc/hosts loading and SIGHUP reload."""
import argparse
import json
import os
import pathlib
import signal
import socket
import struct
import subprocess
import time
import uuid


def query(port, name):
    packet = struct.pack("!HHHHHH", 1234, 0x100, 1, 0, 0, 0)
    packet += b"".join(bytes([len(label)]) + label.encode() for label in name.split("."))
    packet += b"\0" + struct.pack("!HH", 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(0.5)
        sock.sendto(packet, ("127.0.0.1", port))
        response = sock.recv(4096)
    count = struct.unpack_from("!H", response, 6)[0]
    # This probe asks for one A record, with exactly one synthetic hosts entry.
    if count:
        return socket.inet_ntoa(response[-4:])
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-system-hosts-edit", action="store_true",
                        help="Allow temporary, uniquely named test mappings in /etc/hosts")
    parser.add_argument("--wait-seconds", type=float, default=5)
    args = parser.parse_args()
    if not args.allow_system_hosts_edit:
        parser.error("Use --allow-system-hosts-edit only in a disposable development container")
    if args.wait_seconds <= 0:
        parser.error("--wait-seconds must be positive")
    binary = os.environ.get("DNSMASQ_BIN", "/usr/sbin/dnsmasq")
    version = subprocess.check_output([binary, "--version"], text=True).splitlines()[0]
    name = "npm-default-hosts-" + uuid.uuid4().hex + ".invalid"
    hosts = pathlib.Path("/etc/hosts")
    original = hosts.read_bytes()
    insertion = b""
    child = None
    rows = []

    def set_entry(ip):
        nonlocal insertion
        current = hosts.read_bytes()
        if insertion:
            if current.count(insertion) != 1:
                raise RuntimeError("Temporary marker changed unexpectedly; refusing to overwrite hosts")
            current = current.replace(insertion, b"", 1)
        addition = b""
        if ip:
            addition = (b"" if current.endswith(b"\n") else b"\n") + f"{ip} {name}\n".encode()
        # Preserve unrelated concurrent edits instead of restoring a snapshot.
        hosts.write_bytes(current + addition)
        insertion = addition

    def observe(action, expected, seconds):
        start = time.monotonic()
        actual = None
        while True:
            if child.poll() is not None:
                raise RuntimeError("dnsmasq exited: " + child.stderr.read().decode())
            try:
                actual = query(port, name)
            except (TimeoutError, ConnectionRefusedError):
                if time.monotonic() - start >= seconds:
                    raise
            else:
                if actual == expected:
                    break
            if time.monotonic() - start >= seconds:
                break
            time.sleep(0.1)
        rows.append({"action": action, "expected": expected, "actual": actual,
                     "refreshed": actual == expected,
                     "elapsed_ms": round((time.monotonic() - start) * 1000)})
        return actual == expected

    try:
        set_entry("127.0.0.2")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        # No --hostsdir, --addn-hosts or --no-hosts. Keep normal resolv.conf
        # handling, but mark our synthetic name local to prevent external DNS.
        child = subprocess.Popen([
            binary, "--keep-in-foreground", "--conf-file=/dev/null", "--pid-file=",
            "--cache-size=0", "--no-negcache", "--listen-address=127.0.0.1",
            "--bind-interfaces", f"--port={port}", "--log-facility=-", f"--local=/{name}/",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if not observe("initial default /etc/hosts load", "127.0.0.2", 2):
            raise RuntimeError("Initial hosts mapping did not load")
        set_entry("127.0.0.3")
        observe("edit /etc/hosts without signal", "127.0.0.3", args.wait_seconds)
        child.send_signal(signal.SIGHUP)
        if not observe("SIGHUP after edit (positive control)", "127.0.0.3", 2):
            raise RuntimeError("SIGHUP did not reload the changed mapping")
        set_entry(None)
        observe("remove mapping without signal", None, args.wait_seconds)
        child.send_signal(signal.SIGHUP)
        if not observe("SIGHUP after removal (positive control)", None, 2):
            raise RuntimeError("SIGHUP did not remove the mapping")
    finally:
        try:
            if child:
                child.terminate()
                try:
                    child.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate()
        finally:
            if insertion:
                set_entry(None)
            restored = hosts.read_bytes() == original
    print(json.dumps({"version": version, "mode": "default /etc/hosts",
                      "results": rows, "original_hosts_restored": restored}, indent=2))


if __name__ == "__main__":
    main()
