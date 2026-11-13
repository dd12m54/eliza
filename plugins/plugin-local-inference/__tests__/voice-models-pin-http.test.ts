/**
 * Real-HTTP validation of the voice-model pin route (PR #36521).
 *
 * The pin handler must reject a non-boolean `pinned` with 400 without
 * touching the pin store. This suite drives the actual HTTP path: a real
 * `node:http` server serves `handleVoiceModelsRoutes` on loopback and is
 * hit with `fetch()`, against a temporary pin store (`ELIZA_STATE_DIR`).
 * Nothing on the pin path is stubbed — the request flows through real HTTP
 * parsing, `readCompatJsonBody`, the real handler, and the real on-disk
 * pin file.
 *
 * Coverage (maintainer review 2026-11-13):
 * - Invalid pin input (omitted, string, number, null, array, malformed
 *   JSON, empty body) returns 400 and leaves `voice-update-pins.json`
 *   byte-identical.
 * - The source-linked state checks (GET list + GET check) still report the
 *   pre-rejection pinned state after a rejection.
 * - Explicit `pinned: true` persists and `pinned: false` removes the pin,
 *   and the list reflects the store.
 * - `applyVoiceModelManagementMutation` throws on non-boolean `pinned`
 *   without mutating the store.
 */

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	VOICE_MODEL_VERSIONS,
	type VoiceModelId,
} from "@elizaos/plugin-native-inference/model-catalog/voice-models";
import {
	applyVoiceModelManagementMutation,
	handleVoiceModelsRoutes,
	setVoiceModelsBundleVersionForTest,
	setVoiceModelsUpdater,
} from "../src/routes/voice-models-routes";
import type { VoiceModelStatus } from "../src/services/voice-model-updater";
import { VoiceModelUpdater } from "../src/services/voice-model-updater";

/** Echoes the pin set it receives into per-id statuses, so the check
 *  endpoint's `pinned` flags are linked to the on-disk pin source. */
class PinsEchoUpdater {
	async check(
		_installed: unknown,
		pins: { pinned: Set<VoiceModelId> },
		_options?: { force?: boolean },
	): Promise<ReadonlyArray<VoiceModelStatus>> {
		return VOICE_MODEL_VERSIONS.map((v) => ({
			id: v.id,
			installedVersion: null,
			latestKnown: null,
			pinned: pins.pinned.has(v.id),
			decision: { allow: false, reason: "up-to-date" },
		}));
	}
}

let tmpRoot: string;
let prevStateDir: string | undefined;
let base: string;
let server: http.Server;

function pinsPath(): string {
	return path.join(tmpRoot, "local-inference", "voice-update-pins.json");
}

async function readPinsRaw(): Promise<string | null> {
	try {
		return await fsp.readFile(pinsPath(), "utf8");
	} catch {
		return null;
	}
}

async function seedPins(pinned: VoiceModelId[]): Promise<void> {
	await fsp.mkdir(path.join(tmpRoot, "local-inference"), {
		recursive: true,
	});
	await fsp.writeFile(pinsPath(), JSON.stringify({ pinned }), "utf8");
}

async function postPin(
	id: string,
	init: { body?: unknown; rawBody?: string | null },
): Promise<{ status: number; json: Record<string, unknown> | null }> {
	const res = await fetch(
		`${base}/api/local-inference/voice-models/${id}/pin`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body:
				init.rawBody !== undefined
					? init.rawBody
					: init.body === undefined
						? undefined
						: JSON.stringify(init.body),
		},
	);
	let json: Record<string, unknown> | null = null;
	try {
		json = (await res.json()) as Record<string, unknown>;
	} catch {
		json = null;
	}
	return { status: res.status, json };
}

async function listPinned(id: string): Promise<boolean | null> {
	const res = await fetch(`${base}/api/local-inference/voice-models`);
	const body = (await res.json()) as {
		installations: Array<{ id: string; pinned: boolean }>;
	};
	return body.installations.find((i) => i.id === id)?.pinned ?? null;
}

async function checkPinned(id: string): Promise<boolean | null> {
	const res = await fetch(
		`${base}/api/local-inference/voice-models/check`,
	);
	const body = (await res.json()) as {
		statuses: Array<{ id: string; pinned: boolean }>;
	};
	return body.statuses.find((s) => s.id === id)?.pinned ?? null;
}

beforeAll(async () => {
	server = http.createServer((req, res) => {
		void handleVoiceModelsRoutes(req, res)
			.then((handled) => {
				if (!handled && !res.headersSent) {
					res.statusCode = 404;
					res.end(JSON.stringify({ error: "not found" }));
				}
			})
			.catch((err: unknown) => {
				if (!res.headersSent) {
					res.statusCode = 500;
					res.end(
						JSON.stringify({
							error: err instanceof Error ? err.message : "internal error",
						}),
					);
				}
			});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("pin HTTP test server did not bind");
	}
	base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
});

beforeEach(() => {
	tmpRoot = mkdtempSync(path.join(tmpdir(), "voice-models-pin-http-"));
	prevStateDir = process.env.ELIZA_STATE_DIR;
	process.env.ELIZA_STATE_DIR = tmpRoot;
	setVoiceModelsBundleVersionForTest("1.0.0");
	setVoiceModelsUpdater(
		new PinsEchoUpdater() as unknown as VoiceModelUpdater,
	);
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
	else process.env.ELIZA_STATE_DIR = prevStateDir;
	setVoiceModelsBundleVersionForTest(null);
	setVoiceModelsUpdater(null);
});

describe("POST /api/local-inference/voice-models/:id/pin over real HTTP", () => {
	it("returns 400 and leaves the store untouched for non-boolean pinned", async () => {
		await seedPins(["kokoro"]);
		const before = await readPinsRaw();
		expect(before).toBe(JSON.stringify({ pinned: ["kokoro"] }));

		for (const body of [
			{},
			{ pinned: "true" },
			{ pinned: "false" },
			{ pinned: 1 },
			{ pinned: 0 },
			{ pinned: null },
			{ pinned: [] },
		]) {
			const result = await postPin("kokoro", { body });
			expect(result.status).toBe(400);
			expect(result.json?.error).toMatch(/pin requires pinned/);
			// No-mutation-on-rejection: the pin file is byte-identical, and
			// both source-linked state checks still report the old pin.
			expect(await readPinsRaw()).toBe(before);
			expect(await listPinned("kokoro")).toBe(true);
			expect(await checkPinned("kokoro")).toBe(true);
		}
	});

	it("returns 400 and leaves the store untouched for malformed JSON and an empty body", async () => {
		await seedPins(["kokoro"]);
		const before = await readPinsRaw();

		const malformed = await postPin("kokoro", { rawBody: "{not json" });
		expect(malformed.status).toBe(400);
		expect(malformed.json?.error).toMatch(/Invalid JSON body/);
		expect(await readPinsRaw()).toBe(before);
		expect(await listPinned("kokoro")).toBe(true);

		const empty = await postPin("kokoro", { rawBody: null });
		expect(empty.status).toBe(400);
		expect(empty.json?.error).toMatch(/pin requires pinned/);
		expect(await readPinsRaw()).toBe(before);
		expect(await listPinned("kokoro")).toBe(true);
	});

	it("persists explicit true and false through the real HTTP path", async () => {
		expect(await readPinsRaw()).toBeNull();

		const pinned = await postPin("kokoro", { body: { pinned: true } });
		expect(pinned.status).toBe(200);
		expect(pinned.json).toMatchObject({ ok: true, id: "kokoro", pinned: true });
		expect(JSON.parse((await readPinsRaw()) ?? "")).toEqual({
			pinned: ["kokoro"],
		});
		expect(await listPinned("kokoro")).toBe(true);
		expect(await checkPinned("kokoro")).toBe(true);

		const unpinned = await postPin("kokoro", { body: { pinned: false } });
		expect(unpinned.status).toBe(200);
		expect(unpinned.json).toMatchObject({
			ok: true,
			id: "kokoro",
			pinned: false,
		});
		expect(JSON.parse((await readPinsRaw()) ?? "")).toEqual({ pinned: [] });
		expect(await listPinned("kokoro")).toBe(false);
		expect(await checkPinned("kokoro")).toBe(false);
	});

	it("applyVoiceModelManagementMutation throws on non-boolean pinned without mutating the store", async () => {
		await seedPins(["kokoro"]);
		const before = await readPinsRaw();

		await expect(
			applyVoiceModelManagementMutation({
				op: "pin_voice_model",
				id: "kokoro",
			}),
		).rejects.toThrow(/requires pinned/);
		await expect(
			applyVoiceModelManagementMutation({
				op: "pin_voice_model",
				id: "kokoro",
				pinned: "true" as unknown as boolean,
			}),
		).rejects.toThrow(/requires pinned/);
		expect(await readPinsRaw()).toBe(before);
		expect(await listPinned("kokoro")).toBe(true);

		const result = await applyVoiceModelManagementMutation({
			op: "pin_voice_model",
			id: "kokoro",
			pinned: false,
		});
		expect(result).toEqual({
			op: "pin_voice_model",
			id: "kokoro",
			pinned: false,
		});
		expect(JSON.parse((await readPinsRaw()) ?? "")).toEqual({ pinned: [] });
	});
});
