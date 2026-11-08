# patch-nginx-proxy-manager

A standalone image layer for Nginx Proxy Manager. Forward Hostname values resolve
through the NPM container's `/etc/hosts`, then its original DNS servers. Hosts
mtime changes are checked every second, with a one-second Nginx cache. No Nginx reload
is needed. Existing connections retain their original destination.

This standalone repository maintains the hosts resolver extension without
carrying source patches to upstream NPM. The application, frontend, templates,
Dockerfiles and initialization scripts in the upstream project are not replaced.
Builds and tests run from this repository root without the original checkout.

## Build and run

Requires Docker with Buildx and Compose. From this directory:

```sh
# Choose a release tag or digest for reproducible deployments.
export NPM_BASE=jc21/nginx-proxy-manager:latest
export NPM_HOSTS_IMAGE=npm-hosts:local
bash build.sh
python3 test-image.py "$NPM_HOSTS_IMAGE"
docker compose up -d --no-build
```

`latest` tracks the published image, not the latest `develop` source commit.
`build.sh` pulls the base by default and loads a single-platform result into the
local Docker engine. Set `PLATFORM=linux/arm64` when targeting ARM64. Additional
Buildx options may be passed as arguments.

The example Compose file binds the admin UI to `127.0.0.1:81`, stores application
data and certificates in `./data` and `./letsencrypt`, and supplies an example
`backend.internal` hosts mapping. Replace that address before use. For an existing
deployment, change its image to the extension image and retain its existing
volumes, database settings, networks and published ports.

Enter `backend.internal` in Forward Hostname. No Advanced resolver configuration
is required. An existing per-host `resolver` overrides the extension's setting.

`extra_hosts` changes require container recreation. Direct edits to the running
container's `/etc/hosts` update resolution automatically, but do not survive
container recreation. Keep persistent mappings in your deployment configuration.

## Upgrade a published base image

Set `NPM_BASE` to the desired new version (or use `latest` to check for updates),
then repeat build, image tests and `docker compose up -d --no-build`. An unchanged
base and unchanged extension reuse Docker's build cache. Record the base digest
and retain the previous extension image tag for reproducibility. Application
database migration and backup requirements remain those of upstream NPM; an
older image alone may not reverse a database migration.

The base-image checks fail early if required s6, Node, package-manager or Nginx
resolver paths are missing. These checks do not replace the image integration
test when upgrading.

## Automated GitHub image publication

The repository workflow `.github/workflows/publish-hosts-resolver.yml` builds
this extension and publishes it to GitHub Container Registry:

```text
ghcr.io/<repository-owner>/<repository-name>:latest
```

The owner and repository name are automatically converted to lowercase. The
workflow runs monthly on the first day at 03:17 UTC, or manually through
**Actions → Publish hosts resolver image → Run workflow**. Manual runs accept an
`npm_base` tag or digest; scheduled runs use `jc21/nginx-proxy-manager:latest`.
This refreshes the published NPM base, not the latest upstream source checkout.

Each run builds an amd64 test image, executes the integration and enabled/disabled
container startup tests, then publishes an amd64/arm64 image only if those tests
pass. ARM64 is built but is not covered by the amd64 runtime tests. Concurrent
runs are serialized to avoid simultaneous writes to `latest`.

Publishing uses the workflow's `GITHUB_TOKEN` with `packages: write`; no personal
access token is needed. Repository/organization policy must permit Actions and
package publication. Package visibility is managed in GitHub Packages settings.
Forks may need Actions enabled. The workflow must exist on the default branch
for scheduled runs and the manual Run workflow button to be available. GitHub
can delay scheduled runs or disable schedules in inactive public repositories;
see [workflow event rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

To deploy a published image, retain your existing volumes and other settings,
and set the image in your Compose file to its GHCR name. With the example
Compose file, substitute your actual owner and repository below:

```sh
export NPM_HOSTS_IMAGE=ghcr.io/owner/repository:latest
docker compose pull
docker compose up -d --no-build
```

The included workflow already targets this standalone repository root. After
pushing it to a GitHub repository named `patch-nginx-proxy-manager`, the published
image name is `ghcr.io/<repository-owner>/patch-nginx-proxy-manager:latest`.

## Use the latest upstream source

Build an **unmodified** upstream checkout as a base image. Keep that checkout
separate from this extension repository. Starting here, create it once:

```sh
git clone --branch develop --single-branch \
  https://github.com/NginxProxyManager/nginx-proxy-manager.git ../npm-upstream-build
cd ../npm-upstream-build
bash scripts/ci/frontend-build
docker buildx build --pull --load --platform linux/amd64 \
  --build-arg TARGETPLATFORM=linux/amd64 \
  --build-arg BUILD_VERSION=develop \
  --build-arg "BUILD_COMMIT=$(git rev-parse HEAD)" \
  -f docker/Dockerfile -t npm-upstream:local .
```

For later builds, update the clean upstream checkout with
`git -C ../npm-upstream-build pull --ff-only origin develop`, then repeat its
frontend and image build steps. Follow upstream's build instructions if its
build process changes. Back in this repository, layer the extension onto the
local image:

```sh
NPM_BASE=npm-upstream:local PULL_BASE=false bash build.sh
python3 test-image.py npm-hosts:local
docker compose up -d --no-build
```

`PULL_BASE=false` avoids trying to pull a locally built image from a registry.
No cherry-pick or source patch is required. This repository contains the
extension and its tests; the upstream source checkout remains separate.

## Configuration and lifecycle

The extension image enables `ENABLE_HOSTS_RESOLVER=true` by default. Set it to
`false` and recreate the container to use upstream DNS behavior. Do not combine
the enabled feature with `DISABLE_RESOLVER=true`. `DISABLE_IPV6` remains supported.

The only listener is TCP/UDP `127.0.0.1:5353`; no extra published port is needed.
Aliases and IPv4/IPv6 mappings are supported. Unknown/deleted mappings fall back
to nameservers in `/etc/resolv.conf`, including Docker's embedded DNS.

The s6 graph is `prepare -> hosts-resolver -> hosts-monitor -> nginx`. After
upstream preparation, the extension writes the generated resolver file,
preserving its ownership, and runs dnsmasq directly under the configured
`PUID`/`PGID`. A short-lived Node startup check, managed by `s6-notifyoncheck`,
notifies readiness when the local listener is available and then exits.
There is no persistent Node monitoring process.

A separately supervised Bash monitor runs as root to access the s6 control FIFO.
Every second it runs GNU `stat -L --format=%y /etc/hosts` and compares only mtime,
including fractional seconds. It does not open or compare hosts contents.
mtime changes trigger `s6-svc -h` to reload the currently supervised dnsmasq,
without keeping a PID file. Changes which preserve mtime are intentionally not
detected, even if file contents or inode change. File size is not compared.

Every monitor startup forces a reload, covering edits during downtime. Missing
files and failed notifications are retried without advancing the baseline;
errors are rate-limited. s6 restarts either service if its process exits. A
restarted dnsmasq reads the current hosts file itself. Startup dependencies do
not stop Nginx if a service fails later: s6 independently recovers that service.
This is process supervision, not a watchdog for an alive but hung process.
Disabled mode leaves the upstream resolver file untouched. Both services have
a 30-second startup timeout; the monitor handles TERM/INT and has a five-second
forced shutdown timeout.

The extension does not alter the backend, proxy templates or upstream scripts.
Its compatibility surface is Debian/Ubuntu package installation, Node 18+, s6
service definitions, PUID/PGID semantics and the generated Nginx resolver include.

## Tests

```sh
# Root is required for a synthetic DNS upstream on loopback port 53.
S6_BIN_DIR=/path/to/s6/bin DNSMASQ_BIN=/path/to/dnsmasq NGINX_BIN=/path/to/nginx \
  node --test test/hosts-resolver.mjs

# Checks installed scripts and the actual proxy include, then boots disposable
# containers with the extension enabled and disabled. Publishes no ports.
python3 test-image.py npm-hosts:local
```

Local tests use a bundled proxy include fixture; image tests use the base image's
actual proxy include. Coverage includes HTTP destination changes without Nginx
master/worker replacement, aliases, IPv6, DNS fallback, file replacement,
unprivileged DNS reload, killed-monitor and DNS recovery, forced refresh after
monitor downtime, missing-file recovery, intentionally ignored preserved-mtime
edits, configuration conflicts and build compatibility. Local tests require s6
as well as Bash, GNU stat/touch, Node, dnsmasq and Nginx.
The disposable test Nginx explicitly uses the root test user and temporary
directories instead of compiled-in defaults normally prepared by NPM's init.
Its configuration is validated with `nginx -t` before launch, and startup errors
include Nginx stderr and process exit status rather than just a refused socket.
The normal integration tests use temporary files and do not change the host
machine's `/etc/hosts`. The separate opt-in default-hosts probe below does edit
temporary mappings in the current container's `/etc/hosts`.
Image startup tests edit only disposable containers and remove their anonymous
volumes afterward. Each startup container explicitly mounts anonymous volumes
at both `/data` and `/etc/letsencrypt`, matching NPM's initialization requirements.
The runner checks container state while waiting and fails immediately with exit
details and logs if initialization stops the container. The Docker daemon must
be local for the bind-mounted integration tests. Orchestration regression checks
can run without Docker:

```sh
python3 -m unittest discover -s test -p 'test_image_runner.py'
```

## Why not use hostsdir links instead of a monitor?

This was tested with dnsmasq 2.88 (built from the upstream release source with
inotify enabled) and 2.93. A symlink inside `--hostsdir` pointing to an external
hosts file loads initially, but editing or atomically replacing its target does
not refresh the DNS answer. Atomically replacing the symlink entry inside the
watched directory does refresh the answer. The directory watch does not follow
changes to the symlink target in another directory.

The same behavior was verified against this development container's actual
`/etc/hosts`: changing a temporary test mapping from `127.0.0.2` to `127.0.0.3`
left the DNS answer at `127.0.0.2` after two seconds. Replacing the symlink in the
watched directory immediately exposed `127.0.0.3`. Removing the temporary mapping
from `/etc/hosts` also left the old answer until a directory event/reload. The
original hosts contents were restored after each version's test.

Consequently, this optimization does not replace the existing monitor while
preserving automatic `/etc/hosts` updates. A reproducible diagnostic compares
regular files in the watched directory with external symlink and hardlink targets:

```sh
DNSMASQ_BIN=/path/to/dnsmasq-2.88 node test/hostsdir-probe.mjs
```

The diagnostic prints observations rather than treating a stale result as a test
failure. It runs dnsmasq directly, without our wrapper or SIGHUP, uses temporary
files only, and does not modify the system `/etc/hosts`. Results include initial
load, in-place edits, atomic replacement, mapping removal and a symlink-entry
replacement as a positive control. An external monitor is still needed; the
current implementation checks mtime as described above.

Hardlinks were also tested on both versions using temporary files on the same
filesystem. Although both paths initially shared an inode, writing via the path
outside the watched directory left the DNS answer unchanged. Writing via the
hardlink entry inside the watched directory did refresh the answer. Atomic
replacement of the external path created a new inode, leaving the hardlink
attached to the old contents. Directory inotify watches do not report writes
through links outside the directory; see [inotify(7)](https://man7.org/linux/man-pages/man7/inotify.7.html).

Attempts to hardlink this container's actual `/etc/hosts` into either `/tmp` or
the workspace also failed with `EXDEV` (Invalid cross-device link). Linux does
not allow hardlinks across mount boundaries, even if the underlying filesystem
is the same; see [link(2)](https://man7.org/linux/man-pages/man2/link.2.html).
Thus a hardlink cannot transparently replace the monitor either. To run only
the hardlink experiment:

```sh
DNSMASQ_BIN=/path/to/dnsmasq-2.88 node test/hostsdir-probe.mjs \
  --mode=hardlink-to-external-file
```

## Default /etc/hosts loading experiment

The default hosts mode was also tested against the actual container `/etc/hosts`
with dnsmasq 2.88 and 2.93, without `--hostsdir`, `--addn-hosts`, `--no-hosts`, a
monitor or automatic signals. DNS query caching was disabled and only a unique
synthetic name was queried, with external forwarding disabled for that name.

Both versions loaded the initial `127.0.0.2` mapping. After changing it to
`127.0.0.3`, queries throughout five seconds still returned `127.0.0.2`. Sending
SIGHUP immediately exposed `127.0.0.3`. Removing the mapping similarly left the
old answer throughout five seconds, and SIGHUP removed it. Original hosts bytes
were restored after each run. Default hosts loading therefore does not eliminate
the monitor; [dnsmasq's manual](https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html)
documents the SIGHUP reload behavior.

To reproduce **only inside a disposable development container**, explicitly
allow temporary modifications to its system hosts file:

```sh
DNSMASQ_BIN=/path/to/dnsmasq-2.88 python3 test/default-hosts-probe.py \
  --allow-system-hosts-edit
```

The script uses a randomly named mapping, reports observed answers and timings,
and cleans up that mapping in a `finally` block. It is not part of the normal
test suite or image smoke test. No production resolver behavior was changed.
