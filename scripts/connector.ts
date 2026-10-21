/**
 * `npm run connector -- <list|set|remove|sample> …` — the credential a connector's deliveries are checked against.
 *
 * A connector is not a token. The token store says who may speak as the owner; this says which outside system may wake
 * the agent about an event, and it can only ever fire one hook (src/server/connectors.ts). The secret is printed once
 * when it is minted, pasted into the sending system, and read by the server per delivery — so rotating it takes effect
 * without a restart, and a leaked secret costs one `set`.
 */
import { createHmac } from "node:crypto";
import { connectorsPath, GITHUB_DELIVERY_PATH, GITHUB_HOOK_ID, mintConnectorSecret, readConnectors, removeGithubConnector, readGithubConnector, writeGithubConnector } from "../src/server/connectors.ts";
import { housePaths } from "../src/server/house.ts";

const [command, ...args] = process.argv.slice(2);
const house = housePaths();

function usage(): never {
	console.log(`usage:
  npm run connector -- list
  npm run connector -- set github [--secret <hex>] [--hook <id>]
  npm run connector -- remove github
  npm run connector -- sample github <event> [--url http://127.0.0.1:8787]

  a set with no --secret mints one and prints it: it is shown once, and lives in ${connectorsPath(house)} (0600).
  sample signs a realistic payload and posts it to a running server, so the whole path can be tried without GitHub.`);
	process.exit(command === undefined || command === "--help" ? 0 : 1);
}

function option(name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

if (command === "list") {
	const stored = readConnectors(house);
	const github = readGithubConnector(house);
	if (github === undefined) console.log(`no connectors (${stored.github === undefined ? "github unset" : "github unreadable"})`);
	else console.log(`github  hook=${github.hookId}  secret=${github.secret.slice(0, 8)}…`);
} else if (command === "set") {
	if (args[0] !== "github") usage();
	const existing = readGithubConnector(house);
	const secret = option("--secret") ?? existing?.secret ?? mintConnectorSecret();
	if (secret.length < 16) {
		console.error("a connector secret must be at least 16 characters: an HMAC key that can be guessed is not a door");
		process.exit(1);
	}
	const hookId = option("--hook") ?? existing?.hookId ?? GITHUB_HOOK_ID;
	writeGithubConnector(house, { secret, hookId });
	console.log(`github connector fires ${hookId}, secret in ${connectorsPath(house)} (0600):`);
	console.log();
	console.log(`  ${secret}`);
	console.log();
	console.log("paste it into the repository's webhook settings as the secret, then send a sample:");
	console.log(`  npm run connector -- sample github issues.opened`);
} else if (command === "remove") {
	if (args[0] !== "github") usage();
	console.log(removeGithubConnector(house) ? "removed the github connector" : "no github connector to remove");
} else if (command === "sample") {
	if (args[0] !== "github") usage();
	const connector = readGithubConnector(house);
	if (connector === undefined) {
		console.error("no github connector: run `npm run connector -- set github` first");
		process.exit(1);
	}
	const url = `${option("--url") ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`}${GITHUB_DELIVERY_PATH}`;
	const sample = args[1] ?? "issues.opened";
	const [event, action = "opened"] = sample.split(".");
	const body = JSON.stringify(samplePayload(event, action));
	const signature = createHmac("sha256", connector.secret).update(body).digest("hex");
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": event,
			"x-github-delivery": `sample-${Date.now()}`,
			"x-hub-signature-256": `sha256=${signature}`,
		},
		body,
	});
	console.log(`${response.status} ${await response.text()}`);
	if (!response.ok) process.exit(1);
} else {
	usage();
}

/**
 * A payload shaped like GitHub's, with the fields the connector reads and nothing else: enough to try the filter, the
 * signature and the prompt locally, and obviously a sample — the numbers and titles say so.
 */
function samplePayload(event: string, action: string): Record<string, unknown> {
	const sender = { login: "DenisSud" };
	const repository = { full_name: "DenisSud/mason" };
	if (event === "pull_request_review") {
		return {
			action,
			repository,
			sender,
			pull_request: { number: 41, title: "Sample: add the deployment shape", html_url: "https://github.com/DenisSud/mason/pull/41" },
			review: { state: "changes_requested", body: "Sample review: the volume must be mounted at the same path on both containers." },
		};
	}
	if (event === "issues") {
		return {
			action,
			repository,
			sender,
			issue: {
				number: 42,
				title: "Sample: the picker should remember the last name",
				html_url: "https://github.com/DenisSud/mason/issues/42",
				state: action === "closed" ? "closed" : "open",
				labels: [{ name: "needs-triage" }],
				body: "Sample issue body: this is a sample, sent by `npm run connector -- sample`, not a real report.",
			},
		};
	}
	return {
		action,
		repository,
		sender,
		pull_request: {
			number: 43,
			title: "Sample: glide the view on send",
			html_url: "https://github.com/DenisSud/mason/pull/43",
			state: action === "closed" ? "closed" : "open",
			draft: action === "ready_for_review",
			merged: false,
			labels: [],
			body: "Sample PR body, posted to exercise the connector end to end.",
		},
	};
}
