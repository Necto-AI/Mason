/**
 * A capability the repository says it ships has to be somewhere a test can find it.
 *
 * `docs/CAPABILITY-PLAN.md` states the done-criterion for every capability it adds: one test in this repository fails if
 * it disappears. Nothing in a running stack proves that — an operator's host can have a volume, an image and an env var
 * that this checkout never mentions, and the next `up` from a fresh clone would be a bot that cannot read a page or hear a
 * voice note, silently. So these read the files that wire each capability in and pin the parts a person would have to
 * delete to remove it.
 *
 * They are deliberately about *presence and shape*, not about behaviour: behaviour is measured where it lives (`asr/`
 * has its own suite, `integrations/telegram` has its own). What is pinned here is that mason still asks for it.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const root = new URL("../", import.meta.url).pathname;

const read = (path: string) => readFile(join(root, path), "utf8");

test("OCR is in the image the tools run on, pinned, and warmed, so a read never downloads", async () => {
	const dockerfile = await read("deploy/env.Dockerfile");
	// Pinned to the upstream tag rather than a branch: the package names the weights revision it was built against, so a
	// floating install would let a rebuilt image read a page differently with nothing in this repository to point at.
	assert.match(dockerfile, /git\+https:\/\/github\.com\/datalab-to\/indra@v\d+\.\d+\.\d+/, "pinned by tag");
	assert.match(dockerfile, /indra-ocr --version/, "the build proves the binary runs");
	// The second lookup runs offline and succeeds only from a warm cache, so a build that could not fetch stops there.
	assert.match(dockerfile, /HF_HUB_OFFLINE=1/, "a cache-less build fails here, not on the first message");
});

test("the ocr skill ships with mason, so every bot gets it without a person copying a file", async () => {
	const skill = await read("skills/ocr/SKILL.md");
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(skill);
	assert.equal(frontmatter["name"], "ocr");
	assert.match(String(frontmatter["description"]), /indra-ocr/, "the skill names the binary it is about");
	assert.match(skill, /indra-ocr <path> --format md/, "and shows the call");
});

test("the transcription service is part of the stack, heard by the relay and by nobody else", async () => {
	const compose = await read("deploy/compose.yaml");
	const asr = compose.slice(compose.indexOf("  mason-asr:"), compose.indexOf("  mason-asr:") + 4_000);
	assert.ok(asr.length > 0, "the service exists in the file the stack is built from");
	assert.match(asr, /ASR_MODEL_DIR: \/models/, "the weights live on a volume, not in the image");
	assert.match(asr, /- mason-mcp/, "the relay reaches it by name");
	// A transcriber takes what a person said: it is on no network an integration with a reachable upstream stands on.
	assert.match(asr, /- mason-out/, "its one way out is the bridge mason's own outbound containers share");
	assert.ok(!/^\s+- mason-edge$/m.test(asr), "and never on the bridge a third-party image shares");
	assert.ok(!/ports:/.test(asr), "nothing published");

	const telegram = await read("deploy/compose.telegram.yaml");
	assert.match(telegram, /TELEGRAM_ASR_URL: \$\{TELEGRAM_ASR_URL:-http:\/\/mason-asr:8100\/transcribe\}/, "on by default");
});

test("the tool machine is reachable only from mason: its own outbound bridge carries nothing else", async () => {
	const compose = await read("deploy/compose.yaml");
	const env = compose.slice(compose.indexOf("  mason-env:"), compose.indexOf("  mason:")); // the env service block
	assert.match(env, /- mason-internal/, "in from mason");
	assert.match(env, /- mason-out/, "out on a bridge of its own");
	assert.ok(!/^\s+- mason-edge$/m.test(env), "and not on the bridge the proxy and an integration share");
	assert.match(compose, /\n  mason-out:\n/, "the network is declared");
});
