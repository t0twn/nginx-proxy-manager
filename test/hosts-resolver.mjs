#!/usr/bin/env node
// Integration test using real dnsmasq and nginx; requires root for the synthetic
// upstream DNS on loopback port 53. No external DNS or hosts file edits are used.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import dgram from "node:dgram";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const scriptDir = process.env.HOSTS_RESOLVER_SCRIPTS || path.join(root, "rootfs/usr/bin");
const readyCheck = process.env.HOSTS_RESOLVER_CHECK || path.join(root, "rootfs/etc/s6-overlay/s6-rc.d/hosts-resolver/data/check");
const s6Dir = process.env.S6_BIN_DIR || "/command";
const execute = promisify(execFile);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const dnsmasq = process.env.DNSMASQ_BIN || "/usr/sbin/dnsmasq";
const nginx = process.env.NGINX_BIN || "nginx";

async function eventually(check, canRetry = () => true) {
	const deadline = Date.now() + 8000;
	let error;
	do {
		try { return await check(); } catch (caught) {
			if (!canRetry()) throw caught;
			error = caught;
		}
		await delay(100);
	} while (Date.now() < deadline);
	throw error;
}

async function freePort() {
	const server = net.createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

async function stop(child) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGTERM");
	await exited;
}

async function startServices(t, dir, hostsFile, resolvFile, port, uid = 0) {
	const services = [];
	const env = { ...process.env, DNSMASQ_BIN: dnsmasq, PATH: `${s6Dir}:${process.env.PATH}` };
	const control = async (options, name) => execute(path.join(s6Dir, "s6-svc"), [options, path.join(dir, name)], { env });
	const wait = async (options, name) => execute(path.join(s6Dir, "s6-svwait"), [options, "-t", "5000", path.join(dir, name)], { env });
	t.after(async () => {
		for (const { name, supervisor } of [...services].reverse()) {
			await control("-xd", name).catch(() => {});
			await stop(supervisor);
		}
		await rm(dir, { recursive: true, force: true });
	});
	for (const name of ["dns", "monitor"]) {
		const service = path.join(dir, name);
		await mkdir(path.join(service, "data"), { recursive: true });
		await writeFile(path.join(service, "notification-fd"), "3\n");
		let command;
		if (name === "dns") {
			await writeFile(path.join(service, "data/check"), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(readyCheck)} ${port}\n`, { mode: 0o755 });
			command = [path.join(s6Dir, "s6-notifyoncheck"), "-d", "-3", "3", "-n", "0", "-T", "4000", "-t", "1000", "-w", "100",
				path.join(s6Dir, "s6-setuidgid"), `${uid}:${uid}`, "bash", path.join(scriptDir, "run-hosts-dns.sh"), hostsFile, resolvFile, port];
		} else {
			command = ["bash", path.join(scriptDir, "hosts-monitor.sh"), hostsFile, path.join(dir, "dns")];
		}
		await writeFile(path.join(service, "run"), `#!/bin/bash\nexec ${command.map(quote).join(" ")}\n`, { mode: 0o755 });
		const supervisor = spawn(path.join(s6Dir, "s6-supervise"), [service], { env, stdio: ["ignore", "ignore", "pipe"] });
		let log = "";
		supervisor.stderr.on("data", (data) => { log += data; });
		services.push({ name, supervisor });
		try { await wait("-U", name); } catch (error) { throw new Error(`${error.message}\n${log}`); }
	}
	const pid = async (name) => Number((await execute(path.join(s6Dir, "s6-svstat"), ["-o", "pid", path.join(dir, name)], { env })).stdout.trim());
	return { control, wait, pid };
}

test("hosts changes reach real Nginx without reload, with DNS fallback", { timeout: 45000 }, async (t) => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "npm-hosts-test-"));
	await chmod(dir, 0o755);
	const hostsFile = path.join(dir, "hosts");
	const resolvFile = path.join(dir, "resolv.conf");
	await writeFile(hostsFile, "127.0.0.1 backend.test alias\n::1 ipv6.test\n");
	await writeFile(resolvFile, "nameserver 127.0.0.2\n");
	const dnsPort = await freePort();
	const upstream = dgram.createSocket("udp4");
	// Synthetic recursive DNS always answers A with a distinct fallback IP.
	upstream.on("message", (query, peer) => {
		let end = 12;
		while (query[end]) end += query[end] + 1;
		end += 5;
		const isA = query.readUInt16BE(end - 4) === 1;
		const header = Buffer.from(query.subarray(0, 12));
		header.writeUInt16BE(0x8180, 2);
		header.writeUInt16BE(isA ? 1 : 0, 6);
		header.writeUInt32BE(0, 8);
		const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 127, 0, 0, 3]);
		upstream.send(Buffer.concat([header, query.subarray(12, end), ...(isA ? [answer] : [])]), peer.port, peer.address);
	});
	upstream.bind(53, "127.0.0.2");
	await once(upstream, "listening");
	t.after(() => upstream.close());
	await startServices(t, dir, hostsFile, resolvFile, dnsPort);
	const dns = new Resolver({ timeout: 500, tries: 1 });
	dns.setServers([`127.0.0.1:${dnsPort}`]);
	assert.deepEqual(await dns.resolve4("BACKEND.TEST"), ["127.0.0.1"]);
	assert.deepEqual(await dns.resolve4("alias"), ["127.0.0.1"]);
	assert.deepEqual(await dns.resolve6("ipv6.test"), ["::1"]);
	assert.deepEqual(await dns.resolve4("dns-only.test"), ["127.0.0.3"]);

	const backendPort = await freePort();
	for (const address of ["127.0.0.1", "127.0.0.2", "127.0.0.3"]) {
		const server = http.createServer((req, res) => res.end(address));
		server.listen(backendPort, address);
		await once(server, "listening");
		t.after(() => new Promise((resolve) => server.close(resolve)));
	}
	const proxyPort = await freePort();
	const proxyInclude = process.env.NPM_PROXY_INCLUDE || path.join(root, "test/fixtures/proxy.conf");
	const conf = path.join(dir, "nginx.conf");
	// This test intentionally bypasses /init. Do not rely on the image's
	// compiled-in nginx user or directories normally created by NPM prepare.
	const tempPaths = ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"];
	for (const name of tempPaths) await mkdir(path.join(dir, name));
	await writeFile(conf, `daemon off;
user root;
worker_processes 1;
error_log stderr warn;
pid ${dir}/nginx.pid;
events {}
http {
    client_body_temp_path ${dir}/client_body;
    proxy_temp_path ${dir}/proxy;
    fastcgi_temp_path ${dir}/fastcgi;
    uwsgi_temp_path ${dir}/uwsgi;
    scgi_temp_path ${dir}/scgi;
    access_log off;
    resolver 127.0.0.1:${dnsPort} valid=1s ipv6=off;
    server {
        listen 127.0.0.1:${proxyPort};
        set $forward_scheme http;
        set $server backend.test;
        set $port ${backendPort};
        set $forward_host $host;
        set $x_forwarded_scheme $scheme;
        set $x_forwarded_proto $scheme;
        location / { include ${proxyInclude}; }
    }
}`);
	const nginxArgs = ["-e", "stderr", "-p", `${dir}/`, "-c", conf];
	try {
		await execute(nginx, ["-t", ...nginxArgs]);
	} catch (error) {
		throw new Error(`Nginx test configuration failed validation:\n${error.stderr || error.message}`, { cause: error });
	}
	const proxy = spawn(nginx, nginxArgs, { stdio: ["ignore", "ignore", "pipe"] });
	let nginxLog = "";
	let spawnError;
	proxy.on("error", (error) => { spawnError = error; });
	proxy.stderr.on("data", (data) => { nginxLog += data; });
	t.after(() => stop(proxy));
	const request = () => new Promise((resolve, reject) => {
		const req = http.get(`http://127.0.0.1:${proxyPort}/`, (res) => {
			let body = "";
			res.on("data", (data) => { body += data; });
			res.on("end", () => resolve(body));
		});
		req.setTimeout(1000, () => req.destroy(new Error("HTTP timeout")));
		req.on("error", reject);
	});
	try {
		await eventually(async () => {
			if (spawnError) throw spawnError;
			assert.equal(await request(), "127.0.0.1", nginxLog);
		}, () => !spawnError && proxy.exitCode === null && proxy.signalCode === null);
	} catch (error) {
		throw new Error(`Nginx did not serve the test request (exit=${proxy.exitCode}, signal=${proxy.signalCode}):\n${nginxLog}\n${error.message}`, { cause: error });
	}
	const pid = await readFile(path.join(dir, "nginx.pid"), "utf8");
	const workerFile = `/proc/${pid.trim()}/task/${pid.trim()}/children`;
	const workers = await readFile(workerFile, "utf8");
	// A normal in-place edit changes mtime and refreshes the same-size mapping.
	await writeFile(hostsFile, "127.0.0.2 backend.test alias\n::1 ipv6.test\n");
	await eventually(async () => assert.equal(await request(), "127.0.0.2"));
	await eventually(async () => assert.deepEqual(await dns.resolve4("alias"), ["127.0.0.2"]));
	// Atomic file replacement removes the mapping; queries must fall back to DNS.
	await writeFile(`${hostsFile}.new`, "::1 ipv6.test\n");
	await rename(`${hostsFile}.new`, hostsFile);
	await eventually(async () => assert.equal(await request(), "127.0.0.3"));
	// New mapping must override a previously returned DNS answer.
	await writeFile(hostsFile, "127.0.0.1 backend.test alias\n::1 ipv6.test\n");
	await eventually(async () => assert.equal(await request(), "127.0.0.1"));
	assert.equal(await readFile(path.join(dir, "nginx.pid"), "utf8"), pid);
	assert.equal(await readFile(workerFile, "utf8"), workers);
	assert.equal(proxy.exitCode, null);
});

test("s6 recovers the mtime monitor and unprivileged DNS daemon", { timeout: 30000 }, async (t) => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "npm-hosts-user-"));
	await chmod(dir, 0o755);
	const hostsFile = path.join(dir, "hosts");
	await writeFile(hostsFile, "127.0.0.4 unprivileged.test\n");
	const resolvFile = path.join(dir, "resolv.conf");
	await writeFile(resolvFile, "nameserver 127.0.0.11\n");
	const port = await freePort();
	const services = await startServices(t, dir, hostsFile, resolvFile, port, 65534);
	const dns = new Resolver({ timeout: 500, tries: 1 });
	dns.setServers([`127.0.0.1:${port}`]);
	assert.deepEqual(await dns.resolve4("unprivileged.test"), ["127.0.0.4"]);
	// An atomic replacement preserving the exact mtime is intentionally ignored.
	await writeFile(`${hostsFile}.new`, "127.0.0.5 unprivileged.test\n");
	execFileSync("touch", ["-r", hostsFile, `${hostsFile}.new`]);
	await rename(`${hostsFile}.new`, hostsFile);
	await delay(1300);
	assert.deepEqual(await dns.resolve4("unprivileged.test"), ["127.0.0.4"]);
	execFileSync("touch", [hostsFile]);
	await eventually(async () => assert.deepEqual(await dns.resolve4("unprivileged.test"), ["127.0.0.5"]));
	const dnsPid = await services.pid("dns");
	const monitorPid = await services.pid("monitor");
	assert.match(await readFile(`/proc/${monitorPid}/comm`, "utf8"), /bash/);
	assert.match(await readFile(`/proc/${dnsPid}/status`, "utf8"), /Uid:\s+65534\s+65534/);
	// A killed monitor must be replaced by s6, without restarting dnsmasq.
	await services.control("-k", "monitor");
	await eventually(async () => {
		const pid = await services.pid("monitor");
		assert(pid > 0 && pid !== monitorPid);
	});
	await services.wait("-U", "monitor");
	assert.equal(await services.pid("dns"), dnsPid);
	// Startup must force a reload, even if a downtime edit preserves mtime.
	await services.control("-d", "monitor");
	await services.wait("-D", "monitor");
	await writeFile(`${hostsFile}.new`, "127.0.0.6 unprivileged.test\n");
	execFileSync("touch", ["-r", hostsFile, `${hostsFile}.new`]);
	await rename(`${hostsFile}.new`, hostsFile);
	await services.control("-u", "monitor");
	await services.wait("-U", "monitor");
	await eventually(async () => assert.deepEqual(await dns.resolve4("unprivileged.test"), ["127.0.0.6"]));
	// Independent DNS crashes also recover; the monitor keeps using s6 control.
	await services.control("-k", "dns");
	await eventually(async () => {
		const pid = await services.pid("dns");
		assert(pid > 0 && pid !== dnsPid);
	});
	await services.wait("-U", "dns");
	await writeFile(hostsFile, "127.0.0.7 unprivileged.test\n");
	await eventually(async () => assert.deepEqual(await dns.resolve4("unprivileged.test"), ["127.0.0.7"]));
	// A missing file is retried rather than interpreted as an empty hosts file.
	await rename(hostsFile, `${hostsFile}.saved`);
	await delay(1200);
	await writeFile(hostsFile, "127.0.0.8 unprivileged.test\n");
	await eventually(async () => assert.deepEqual(await dns.resolve4("unprivileged.test"), ["127.0.0.8"]));
});

test("extension config overrides upstream only when enabled and rejects conflicting options", async (t) => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "npm-resolver-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const output = path.join(dir, "resolvers.conf");
	const helper = path.join(root, "rootfs/usr/bin/configure-hosts-resolver.sh");
	const run = (options) => spawnSync("bash", [helper, output], {
		encoding: "utf8",
		env: { ...process.env, ENABLE_HOSTS_RESOLVER: "", DISABLE_RESOLVER: "", DISABLE_IPV6: "", ...options },
	});
	// Do not touch an upstream/custom resolver when disabled, including the
	// case where DISABLE_RESOLVER means the file does not exist at all.
	assert.equal(run({}).status, 0);
	await assert.rejects(readFile(output), { code: "ENOENT" });
	await writeFile(output, "resolver 127.0.0.11 valid=10s;\n");
	assert.equal(run({}).status, 0);
	assert.equal(await readFile(output, "utf8"), "resolver 127.0.0.11 valid=10s;\n");
	assert.equal(run({ ENABLE_HOSTS_RESOLVER: "YES", DISABLE_IPV6: "true" }).status, 0);
	assert.equal(await readFile(output, "utf8"), "resolver 127.0.0.1:5353 ipv6=off valid=1s;\n");
	assert.equal(run({ ENABLE_HOSTS_RESOLVER: "true" }).status, 0);
	assert.equal(await readFile(output, "utf8"), "resolver 127.0.0.1:5353 valid=1s;\n");
	const conflict = run({ ENABLE_HOSTS_RESOLVER: "true", DISABLE_RESOLVER: "true" });
	assert.notEqual(conflict.status, 0);
	assert.match(conflict.stderr, /cannot both be enabled/);
	await writeFile(output, "resolver 192.0.2.53;\n");
	assert.equal(run({ DISABLE_RESOLVER: "true" }).status, 0);
	assert.equal(await readFile(output, "utf8"), "resolver 192.0.2.53;\n");
});

test("build wrapper supports published and local base images from any directory", async (t) => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "npm-hosts-build-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	// Record arguments without contacting a Docker daemon or registry.
	const fakeDocker = path.join(dir, "docker");
	const output = path.join(dir, "args");
	await writeFile(fakeDocker, '#!/bin/bash\nprintf "%s\\n" "$@" > "$TEST_DOCKER_ARGS"\n', { mode: 0o755 });
	const run = (options) => spawnSync("bash", [path.join(root, "build.sh")], {
		cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
			TEST_DOCKER_ARGS: output, PULL_BASE: "true", PLATFORM: "", NPM_BASE: "example/npm:release", NPM_HOSTS_IMAGE: "example/hosts:test", ...options },
	});
	assert.equal(run({}).status, 0);
	let args = (await readFile(output, "utf8")).trim().split("\n");
	assert(args.includes("--pull"));
	assert(args.includes("NPM_BASE=example/npm:release"));
	assert(args.includes("example/hosts:test"));
	assert.equal(args.at(-1), path.resolve(root));
	assert.equal(run({ PULL_BASE: "false", NPM_BASE: "npm-upstream:local", PLATFORM: "linux/arm64" }).status, 0);
	args = (await readFile(output, "utf8")).trim().split("\n");
	assert(!args.includes("--pull"));
	assert(args.includes("NPM_BASE=npm-upstream:local"));
	assert(args.includes("linux/arm64"));
});

test("base compatibility check rejects missing resolver integration", async (t) => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "npm-hosts-base-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const { mkdir } = await import("node:fs/promises");
	for (const name of ["command", "etc/s6-overlay/s6-rc.d/prepare", "etc/s6-overlay/s6-rc.d/nginx", "etc/s6-overlay/s6-rc.d/user/contents.d", "etc/nginx/conf.d/include"]) {
		await mkdir(path.join(dir, name), { recursive: true });
	}
	for (const name of ["init", "command/with-contenv", "command/s6-setuidgid", "command/s6-notifyoncheck", "command/s6-svc", "etc/s6-overlay/s6-rc.d/prepare/type", "etc/s6-overlay/s6-rc.d/nginx/type"]) {
		await writeFile(path.join(dir, name), "");
	}
	const conf = path.join(dir, "etc/nginx/nginx.conf");
	await writeFile(conf, "include /etc/nginx/conf.d/include/resolvers[.]conf;\n");
	// Point filesystem checks into the fixture; production script still checks
	// the real image paths before installing or copying the extension.
	const script = (await readFile(path.join(root, "check-base.sh"), "utf8"))
		.replaceAll("/etc/", `${dir}/etc/`).replaceAll("/command/", `${dir}/command/`)
		.replaceAll(" /init ", ` ${dir}/init `);
	const run = () => spawnSync("bash", ["-c", script], { encoding: "utf8", env: process.env });
	// The literal include check is also redirected into the fixture.
	await writeFile(conf, `include ${dir}/etc/nginx/conf.d/include/resolvers[.]conf;\n`);
	assert.equal(run().status, 0);
	await writeFile(conf, "http {}\n");
	const failure = run();
	assert.notEqual(failure.status, 0);
	assert.match(failure.stderr, /no longer includes/);
});
