import * as fs from "node:fs";
import * as path from "node:path";

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string): T {
	return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, value: unknown): void {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
