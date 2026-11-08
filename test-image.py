#!/usr/bin/env python3
"""Test an already-built extension image in disposable containers."""
import json
import pathlib
import subprocess
import sys
import time
import uuid


def docker(*args, check=True):
    return subprocess.run(
        ["docker", *args], check=check, text=True, capture_output=True
    )


def wait_for(container, script):
    deadline = time.monotonic() + 90
    last = None
    while time.monotonic() < deadline:
        result = docker("inspect", "--format", "{{json .State}}", container,
                        check=False)
        if result.returncode:
            raise RuntimeError(result.stderr or f"Cannot inspect container {container}")
        state = json.loads(result.stdout)
        if not state.get("Running"):
            raise RuntimeError(
                f"Container {container} stopped "
                f"(status={state.get('Status')}, exit={state.get('ExitCode')}): "
                f"{state.get('Error') or 'see container logs'}"
            )
        last = docker("exec", container, "node", "-e", script, check=False)
        if last.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError(last.stderr if last else "Container did not become ready")


HTTP_CHECK = """
require('http').get('http://127.0.0.1:80/', r => {
    r.resume(); r.on('end', () => process.exit(0));
}).on('error', () => process.exit(1)).setTimeout(1000, function() {
    this.destroy(); process.exit(1);
});
"""


def check_startup(image, enabled):
    name = "npm-hosts-smoke-" + uuid.uuid4().hex[:12]
    try:
        docker("run", "-d", "--name", name,
               "--volume", "/data", "--volume", "/etc/letsencrypt",
               "-e", f"ENABLE_HOSTS_RESOLVER={str(enabled).lower()}",
               "-e", "DISABLE_IPV6=true",
               "--add-host", "extension-smoke.test:127.0.0.2", image)
        wait_for(name, HTTP_CHECK)
        config = docker("exec", name, "cat",
                        "/etc/nginx/conf.d/include/resolvers.conf").stdout
        if enabled:
            assert config.strip() == "resolver 127.0.0.1:5353 ipv6=off valid=1s;", config
            query = """
const dns = new (require('dns').promises.Resolver)({timeout:500, tries:1});
dns.setServers(['127.0.0.1:5353']);
dns.resolve4('extension-smoke.test').then(a => {
    require('assert').deepStrictEqual(a, ['EXPECTED_IP']);
}).catch(e => { console.error(e); process.exit(1); });
"""
            wait_for(name, query.replace("EXPECTED_IP", "127.0.0.2"))
            docker("exec", name, "node", "-e", r"""
const fs = require('fs');
const lines = fs.readFileSync('/etc/hosts', 'utf8').split('\n')
    .filter(line => !line.split(/\s+/).includes('extension-smoke.test'));
fs.writeFileSync('/etc/hosts', lines.join('\n') + '\n127.0.0.3 extension-smoke.test\n');
""")
            wait_for(name, query.replace("EXPECTED_IP", "127.0.0.3"))
        else:
            assert "127.0.0.1:5353" not in config, config
        docker("exec", name, "nginx", "-t")
    except Exception:
        logs = docker("logs", "--tail", "80", name, check=False)
        print(logs.stdout + logs.stderr, file=sys.stderr)
        raise
    finally:
        docker("rm", "-f", "-v", name, check=False)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 test-image.py <built-image>")
    image = sys.argv[1]
    directory = pathlib.Path(__file__).resolve().parent
    result = docker("run", "--rm", "--entrypoint", "node",
                    "--mount", f"type=bind,src={directory},dst=/extension,readonly",
                    "-e", "HOSTS_RESOLVER_SCRIPTS=/usr/bin",
                    "-e", "HOSTS_RESOLVER_CHECK=/etc/s6-overlay/s6-rc.d/hosts-resolver/data/check",
                    "-e", "NPM_PROXY_INCLUDE=/etc/nginx/conf.d/include/proxy.conf",
                    image, "--test", "/extension/test/hosts-resolver.mjs",
                    check=False)
    print(result.stdout, end="", flush=True)
    if result.returncode:
        raise SystemExit(result.stderr or result.returncode)
    check_startup(image, enabled=True)
    check_startup(image, enabled=False)
    print("Image integration and enabled/disabled startup checks passed")


if __name__ == "__main__":
    main()
