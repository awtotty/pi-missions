import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
const runtime = fs.readFileSync(path.join(repoRoot, "extensions", "missions", "runtime-extension.ts"), "utf8");

function fail(message) {
	console.error(`README command validation failed: ${message}`);
	process.exit(1);
}

const commandsSection = readme.match(/## Commands\n\n```text\n([\s\S]*?)\n```/);
if (!commandsSection) fail("missing ## Commands text block");
const commandBlock = commandsSection[1];

const expectedReadmeLines = [
	"/missions [goal]",
	"/missions new [goal]",
	"/missions run [id]",
	"/missions resume [id]",
	"/missions status [id]",
	"/missions list",
	"/missions clear",
	"/missions models",
	"/missions models <role> <model>",
	"/mission-control [id]",
	"/mission ...",
];
for (const line of expectedReadmeLines) {
	if (!commandBlock.includes(line)) fail(`README command block missing ${line}`);
}

const requiredRuntimeMarkers = [
	"pi.registerCommand(\"missions\"",
	"pi.registerCommand(\"mission-control\"",
	"pi.registerCommand(\"mission\"",
	"subcommand === \"new\"",
	"[\"status\", \"run\", \"resume\", \"list\", \"clear\", \"models\"]",
	"subcommand === \"models\"",
	"if (modelArgs[0] === \"set\") modelArgs.shift();",
	"subcommand === \"status\"",
	"subcommand === \"run\" || subcommand === \"resume\"",
	"subcommand === \"list\"",
	"subcommand === \"clear\"",
	"handleMissions(args, ctx)",
];
for (const marker of requiredRuntimeMarkers) {
	if (!runtime.includes(marker)) fail(`runtime missing marker for README commands: ${marker}`);
}

const usage = runtime.match(/const usage = "([^"]+)";/)?.[1] ?? "";
for (const token of ["/missions [goal]", "/missions new [goal]", "run|resume", "status [id]", "list", "clear", "models"]) {
	if (!usage.includes(token)) fail(`runtime usage string missing ${token}`);
}

console.log("README command validation passed.");
