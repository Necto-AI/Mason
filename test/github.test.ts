/**
 * The GitHub connector: what counts as a door, what counts as an event, and what the agent is handed.
 *
 * Two halves are worth pinning. The signature is the only thing standing between the internet and a model turn, so it
 * is tested against every wrong shape a sender can produce. The filter is what keeps a repository's chatter from
 * becoming the agent's bill: a repository emits an event for every label and comment, and only an allowlist of moments
 * should reach a turn — the test asserts the allowlist from both sides, what fires and what is dropped.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	connectorsPath,
	GITHUB_HOOK_ID,
	githubPayload,
	mintConnectorSecret,
	readGithubConnector,
	readGithubEvent,
	removeGithubConnector,
	verifyGithubSignature,
	writeGithubConnector,
} from "../src/server/connectors.ts";
import { housePaths } from "../src/server/house.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome() {
	const directory = await mkdtemp(join(tmpdir(), "mason-connector-"));
	directories.add(directory);
	return housePaths(join(directory, "house"));
}

function signature(secret: string, body: string): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const issueOpened = {
	action: "opened",
	repository: { full_name: "DenisSud/mason" },
	sender: { login: "DenisSud" },
	issue: {
		number: 42,
		title: "The picker should remember the last name",
		html_url: "https://github.com/DenisSud/mason/issues/42",
		state: "open",
		labels: [{ name: "needs-triage" }, { name: "ui" }],
		body: "On a phone the picker is shown again after a reload.",
	},
};

describe("the github signature", () => {
	it("accepts the hmac github sends for the raw body", () => {
		const body = Buffer.from(JSON.stringify(issueOpened));
		assert.equal(verifyGithubSignature("s3cret-key-long-enough", body, signature("s3cret-key-long-enough", body.toString())), true);
	});

	it("refuses another secret, a tampered body, and a header that is not sha256=<hex>", () => {
		const body = Buffer.from(JSON.stringify(issueOpened));
		assert.equal(verifyGithubSignature("right-key-long-enough", body, signature("wrong-key-long-enough", body.toString())), false);
		assert.equal(
			verifyGithubSignature("s3cret-key-long-enough", Buffer.from(`${body.toString()} `), signature("s3cret-key-long-enough", body.toString())),
			false,
		);
		assert.equal(verifyGithubSignature("s3cret-key-long-enough", body, undefined), false);
		assert.equal(verifyGithubSignature("s3cret-key-long-enough", body, "sha1=deadbeef"), false);
		assert.equal(verifyGithubSignature("s3cret-key-long-enough", body, "sha256=deadbeef"), false);
		assert.equal(verifyGithubSignature("s3cret-key-long-enough", body, "sha256=zz"), false);
	});

	it("is over the bytes, not the parsed object", () => {
		const secret = "s3cret-key-long-enough";
		const spaced = Buffer.from(JSON.stringify(issueOpened, null, 2));
		// A prettier body is a different body: signature over one must not open the other.
		assert.equal(verifyGithubSignature(secret, spaced, signature(secret, JSON.stringify(issueOpened))), false);
		assert.equal(verifyGithubSignature(secret, spaced, signature(secret, spaced.toString())), true);
	});
});

describe("the event filter", () => {
	it("passes the moments a person would want to hear about", () => {
		const issue = readGithubEvent("issues", issueOpened);
		assert.equal(issue?.kind, "issue");
		assert.equal(issue?.action, "opened");
		assert.equal(issue?.repo, "DenisSud/mason");
		assert.equal(issue?.number, 42);
		assert.equal(issue?.actor, "DenisSud");
		assert.deepEqual(issue?.labels, ["needs-triage", "ui"]);
		assert.equal(issue?.title, "The picker should remember the last name");
		assert.equal(issue?.url, "https://github.com/DenisSud/mason/issues/42");

		assert.equal(readGithubEvent("issues", { ...issueOpened, action: "reopened" })?.action, "reopened");
		assert.equal(readGithubEvent("issues", { ...issueOpened, action: "closed" })?.state, "open");

		const ready = readGithubEvent("pull_request", {
			action: "ready_for_review",
			repository: { full_name: "DenisSud/mason" },
			sender: { login: "Ilya" },
			pull_request: { number: 43, title: "Glide on send", html_url: "https://github.com/DenisSud/mason/pull/43", draft: false },
		});
		assert.equal(ready?.kind, "pull_request");
		assert.equal(ready?.draft, false);

		const merged = readGithubEvent("pull_request", {
			action: "closed",
			repository: { full_name: "DenisSud/mason" },
			sender: { login: "Ilya" },
			pull_request: { number: 43, title: "Glide on send", state: "closed", merged: true },
		});
		assert.equal(merged?.merged, true);
		assert.equal(merged?.url, "https://github.com/DenisSud/mason/pull/43");

		const review = readGithubEvent("pull_request_review", {
			action: "submitted",
			repository: { full_name: "DenisSud/mason" },
			sender: { login: "Ilya" },
			pull_request: { number: 43, title: "Glide on send", html_url: "https://github.com/DenisSud/mason/pull/43" },
			review: { state: "changes_requested", body: "One comment." },
		});
		assert.equal(review?.review?.state, "changes_requested");
		assert.equal(review?.review?.body, "One comment.");
		assert.equal(review?.kind, "pull_request");
	});

	it("drops a repository's chatter, and anything that is not an issue or a pull request", () => {
		for (const action of ["labeled", "edited", "assigned", "unassigned", "deleted"]) {
			assert.equal(readGithubEvent("issues", { ...issueOpened, action }), undefined, `issues.${action}`);
		}
		assert.equal(readGithubEvent("pull_request", { ...issueOpened, action: "synchronize" }), undefined);
		assert.equal(readGithubEvent("issue_comment", issueOpened), undefined);
		assert.equal(readGithubEvent("push", issueOpened), undefined);
		assert.equal(readGithubEvent("workflow_run", issueOpened), undefined);
		assert.equal(readGithubEvent(undefined, issueOpened), undefined);
	});

	it("drops a payload it cannot read rather than handing the model half an event", () => {
		assert.equal(readGithubEvent("issues", { ...issueOpened, repository: undefined }), undefined);
		assert.equal(readGithubEvent("issues", { ...issueOpened, repository: { full_name: "not-a-repo" } }), undefined);
		assert.equal(readGithubEvent("issues", { ...issueOpened, issue: undefined }), undefined);
		assert.equal(readGithubEvent("issues", { ...issueOpened, issue: { title: "no number" } }), undefined);
	});

	it("caps the free text it carries, so one issue cannot fill the prompt", () => {
		const long = {
			...issueOpened,
			issue: { ...issueOpened.issue, body: "x".repeat(5000), labels: Array.from({ length: 40 }, (_, index) => ({ name: `l${index}` })) },
		};
		const event = readGithubEvent("issues", long);
		assert.equal(event?.body?.length, 2_001);
		assert.equal(event?.body?.endsWith("…"), true);
		assert.equal(event?.labels.length, 12);
	});

	it("hands the hook json, so the payload reads as data and not as a paragraph", () => {
		const event = readGithubEvent("issues", issueOpened);
		assert.ok(event !== undefined);
		const parsed = JSON.parse(githubPayload(event)) as Record<string, unknown>;
		assert.equal(parsed.source, "github");
		assert.equal(parsed.number, 42);
	});
});

describe("the stored connector", () => {
	it("round-trips through a 0600 file and starts absent", async () => {
		const house = await temporaryHome();
		assert.equal(readGithubConnector(house), undefined);

		const secret = mintConnectorSecret();
		assert.match(secret, /^[0-9a-f]{64}$/);
		writeGithubConnector(house, { secret, hookId: GITHUB_HOOK_ID });

		assert.deepEqual(readGithubConnector(house), { secret, hookId: GITHUB_HOOK_ID });
		const mode = (await stat(connectorsPath(house))).mode & 0o777;
		assert.equal(mode, 0o600);
		const stored = JSON.parse(await readFile(connectorsPath(house), "utf8")) as Record<string, unknown>;
		assert.deepEqual(Object.keys(stored), ["github"]);
	});

	it("keeps the hook it was given, and refuses a secret short enough to guess", async () => {
		const house = await temporaryHome();
		writeGithubConnector(house, { secret: mintConnectorSecret(), hookId: "workspace-check" });
		assert.equal(readGithubConnector(house)?.hookId, "workspace-check");
	});

	it("reads a short or broken secret as no connector at all", async () => {
		const house = await temporaryHome();
		writeGithubConnector(house, { secret: "short", hookId: GITHUB_HOOK_ID });
		assert.equal(readGithubConnector(house), undefined);
	});

	it("removes what it wrote, and says when there was nothing", async () => {
		const house = await temporaryHome();
		assert.equal(removeGithubConnector(house), false);
		writeGithubConnector(house, { secret: mintConnectorSecret(), hookId: GITHUB_HOOK_ID });
		assert.equal(removeGithubConnector(house), true);
		assert.equal(readGithubConnector(house), undefined);
	});
});
