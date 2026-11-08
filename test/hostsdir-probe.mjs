#!/usr/bin/env node
// Diagnostic only: test dnsmasq's own hostsdir notifications, without our
// wrapper, polling monitor, or SIGHUP. Does not modify the system /etc/hosts.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { once } from "node:events";
import { chmod, link, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const binary = process.env.DNSMASQ_BIN || "/usr/sbin/dnsmasq";
console.log(execFileSync(binary, ["--version"], { encoding: "utf8" }).split("\n")[0]);
const directory = await mkdtemp(path.join(os.tmpdir(), "npm-hostsdir-probe-"));
await chmod(directory, 0o755);
const rows = [];
async function answers(dns, name) {
	try { return await dns.resolve4(name); } catch (error) {
		if (["ENOTFOUND", "ENODATA", "EREFUSED", "ESERVFAIL"].includes(error.code)) return [];
		throw error;
	}
}
async function observe(dns, mode, action, expected) {
	const start = Date.now();
	let actual;
	do {
		actual = await answers(dns, "hostsdir-probe.invalid");
		if (JSON.stringify(actual) === JSON.stringify(expected)) break;
		await delay(100);
	} while (Date.now() - start < 2000);
	const matched = JSON.stringify(actual) === JSON.stringify(expected);
	rows.push({ mode, action, expected, actual, refreshed: matched, elapsed_ms: Date.now() - start });
	return matched;
}
const modes = ["regular-file", "symlink-to-external-file", "hardlink-to-external-file"];
const selected = process.argv.find((arg) => arg.startsWith("--mode="))?.slice(7);
try {
	assert(!selected || modes.includes(selected), "Unknown --mode");
	for (const mode of modes.filter((value) => !selected || value === selected)) {
		const watched = path.join(directory, mode);
		await mkdir(watched);
		const entry = path.join(watched, "hosts");
		const target = mode === "regular-file" ? entry : path.join(directory, "external-hosts");
		await writeFile(target, "127.0.0.2 hostsdir-probe.invalid\n");
		const createLink = mode === "hardlink-to-external-file" ? link : symlink;
		if (target !== entry) await createLink(target, entry);
		if (mode === "hardlink-to-external-file") {
			assert.equal((await stat(target)).ino, (await stat(entry)).ino);
		}
		const socket = net.createServer();
		socket.listen(0, "127.0.0.1");
		await once(socket, "listening");
		const port = socket.address().port;
		await new Promise((resolve) => socket.close(resolve));
		const child = spawn(binary, ["--keep-in-foreground", "--conf-file=/dev/null", "--pid-file=",
			"--no-hosts", "--no-resolv", `--hostsdir=${watched}`, "--cache-size=0", "--no-negcache",
			"--listen-address=127.0.0.1", "--bind-interfaces", `--port=${port}`, "--log-facility=-"],
			{ stdio: ["ignore", "ignore", "pipe"] });
		let log = "";
		child.stderr.on("data", (data) => { log += data; });
		try {
			const dns = new Resolver({ timeout: 200, tries: 1 });
			dns.setServers([`127.0.0.1:${port}`]);
			await delay(200);
			assert.equal(child.exitCode, null, log);
			assert(await observe(dns, mode, "initial load", ["127.0.0.2"]), log);
			await writeFile(target, "127.0.0.3 hostsdir-probe.invalid\n");
			await observe(dns, mode, "edit target in place", ["127.0.0.3"]);
			if (mode === "hardlink-to-external-file") {
				// Same inode, different pathname: directory notifications depend
				// on which directory entry was used to open the file for writing.
				await writeFile(entry, "127.0.0.33 hostsdir-probe.invalid\n");
				assert(await observe(dns, mode, "edit via watched hardlink entry", ["127.0.0.33"]), log);
			}
			await writeFile(`${target}.new`, "127.0.0.4 hostsdir-probe.invalid\n");
			await rename(`${target}.new`, target);
			if (mode === "hardlink-to-external-file") {
				assert.notEqual((await stat(target)).ino, (await stat(entry)).ino);
			}
			await observe(dns, mode, "replace target atomically", ["127.0.0.4"]);
			await writeFile(target, "# mapping removed\n");
			await observe(dns, mode, "remove mapping from target", []);
			if (target !== entry) {
				// Positive control: a rename into the watched directory generates
				// IN_MOVED_TO even though edits to the external target did not.
				await writeFile(target, "127.0.0.5 hostsdir-probe.invalid\n");
				await createLink(target, path.join(watched, ".replacement"));
				await rename(path.join(watched, ".replacement"), entry);
				assert(await observe(dns, mode, "replace link inside watched directory", ["127.0.0.5"]), log);
			}
		} finally {
			if (child.exitCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGTERM");
				await exited;
			}
		}
	}
	console.log(JSON.stringify(rows, null, 2));
} finally {
	await rm(directory, { recursive: true, force: true });
}
