import { createConnection } from "node:net";
import { resolve } from "node:path";

const root = process.cwd();
const pidPath = resolve(root, ".par-physics-playground-dev.pid");
const port = 8113;
const command = process.argv[2] ?? "start";
const vitePath = resolve(root, "node_modules/vite/bin/vite.js");
interface Ownership {
	readonly pid: number;
	readonly identity: string;
	readonly root: string;
}

async function identity(pid: number): Promise<string> {
	const result = Bun.spawn(
		["ps", "-p", String(pid), "-o", "stat=", "-o", "lstart=", "-o", "command="],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const output = await new Response(result.stdout).text();
	return (await result.exited) === 0 && !/^Z/.test(output.trim())
		? output.trim().replace(/^\S+\s+/, "")
		: "";
}
async function occupied(): Promise<boolean> {
	return new Promise((done, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			done(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			socket.destroy();
			if (error.code === "ECONNREFUSED") done(false);
			else reject(error);
		});
		socket.setTimeout(500, () => {
			socket.destroy();
			reject(
				Error(
					"Port probe timed out; refusing to change a possibly occupied listener",
				),
			);
		});
	});
}
async function readOwner(): Promise<Ownership | undefined> {
	if (!(await Bun.file(pidPath).exists())) return undefined;
	const owner: Ownership = await Bun.file(pidPath).json();
	if (
		!Number.isInteger(owner.pid) ||
		owner.pid <= 1 ||
		owner.root !== root ||
		typeof owner.identity !== "string" ||
		!owner.identity.includes(vitePath)
	)
		throw Error(
			"Invalid server ownership record; refusing to signal any process",
		);
	return owner;
}
async function clearOwner(owner: Ownership): Promise<void> {
	if ((await readOwner())?.pid === owner.pid) await Bun.file(pidPath).delete();
}
async function stop(): Promise<void> {
	const owner = await readOwner();
	if (!owner) {
		if (await occupied())
			throw Error(
				"Port is occupied without an owned server; refusing to stop it",
			);
		return;
	}
	const current = await identity(owner.pid);
	if (current && current !== owner.identity)
		throw Error(
			"Server PID identity changed; refusing to stop an unrelated process",
		);
	if (current) {
		const check = Bun.spawnSync(
			["lsof", "-a", "-p", String(owner.pid), "-d", "cwd", "-Fn"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const cwd = check.stdout
			.toString()
			.split("\n")
			.find((line) => line.startsWith("n"))
			?.slice(1);
		if (cwd !== root)
			throw Error("Server working directory differs; refusing to stop it");
		process.kill(owner.pid, "SIGTERM");
	}
	const deadline = Date.now() + 2500;
	let escalated = false;
	while (Date.now() < deadline) {
		const live = await identity(owner.pid);
		const busy = await occupied();
		if (!live && !busy) {
			await clearOwner(owner);
			return;
		}
		if (live && live.slice(0, 24) !== owner.identity.slice(0, 24))
			throw Error("PID was reused while stopping; refusing further signals");
		if (live && !escalated && Date.now() > deadline - 1200) {
			process.kill(owner.pid, "SIGKILL");
			escalated = true;
		}
		await Bun.sleep(50);
	}
	throw Error(
		"Owned server did not release its listener before the shutdown deadline",
	);
}
if (!["start", "stop", "restart"].includes(command))
	throw Error("Expected start, stop or restart");
if (command === "stop") {
	await stop();
	process.exit(0);
}
if (command === "restart") await stop();
if (await readOwner())
	throw Error("An owned server is already recorded; stop it before starting");
if (await occupied())
	throw Error(`Port ${port} is occupied; refusing to start`);
const child = Bun.spawn(
	[
		process.execPath,
		vitePath,
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"--strictPort",
	],
	{ cwd: root, stdout: "inherit", stderr: "inherit" },
);
const owner: Ownership = {
	pid: child.pid,
	identity: await identity(child.pid),
	root,
};
if (!owner.identity.includes(vitePath)) {
	child.kill();
	throw Error("Could not establish server process ownership");
}
await Bun.write(pidPath, JSON.stringify(owner));
const maximumLifetime = setTimeout(
	() => child.kill("SIGTERM"),
	4 * 60 * 60 * 1000,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => child.kill(signal));
const exitCode = await child.exited;
clearTimeout(maximumLifetime);
await clearOwner(owner);
process.exit(exitCode);
