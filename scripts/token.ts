/**
 * `npm run token -- <add|list|grants|revoke> …` — the credentials that may read and administer mason.
 *
 * The token is printed once, when it is minted, and stored as a hash: losing it means minting another, which is the
 * property that makes a leaked `~/.mason/config.json` worth nothing. A running server reads the file per request, so a
 * revoke or a narrowed grant lands immediately — no restart, and no window where a lost phone still works.
 *
 * Grants are the panel's powers (`src/server/auth.ts`): `conversation` reads the projected transcript, `trace` the raw
 * entries, `admin` the configuration and `approve` the pending tool questions. A new device gets `conversation`.
 */

import { listTokens, mintToken, pairingUrls, revokeToken, setTokenGrants } from "../src/server/auth.ts";
import { housePaths } from "../src/server/house.ts";
import { grantsOf, isOperatorGrant, OPERATOR_GRANTS, type OperatorGrant } from "../src/shared/admin.ts";

const [command, ...args] = process.argv.slice(2);
const home = housePaths().home;
/** The address to print with a new token. A server started elsewhere will differ; the token is what matters. */
const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

function usage(): never {
	console.log(`usage:
  npm run token -- list
  npm run token -- add --label phone [--grants conversation,admin]
  npm run token -- grants <id> conversation,trace
  npm run token -- revoke <id>

  home: ${home}
  grants: ${OPERATOR_GRANTS.join(", ")}. A new device gets conversation; the first token of a fresh home also gets
  admin and approve. The trace is granted on purpose: it is the model's working notes, not the conversation.
  a running server reads its tokens per request: a revoke or a narrowed grant is live, without a restart.`);
	process.exit(command === undefined || command === "--help" ? 0 : 1);
}

/** `--grants a,b` or the one argument of the `grants` command, checked against the set mason has. */
function grantsFrom(raw: string | undefined): OperatorGrant[] | undefined {
	if (raw === undefined) return undefined;
	const grants: OperatorGrant[] = [];
	for (const word of raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")) {
		if (!isOperatorGrant(word)) {
			console.error(`"${word}" is not a grant: the whole set is ${OPERATOR_GRANTS.join(", ")}`);
			process.exit(1);
		}
		grants.push(word);
	}
	return grants;
}

if (command === "list") {
	const tokens = await listTokens(home);
	if (tokens.length === 0) console.log("no tokens");
	for (const token of tokens) {
		const grants = grantsOf(token);
		console.log(
			`${token.id}  ${token.label.padEnd(12)}  created ${token.createdAt}  ${grants.length === 0 ? "no grants" : grants.join(",")}`,
		);
	}
} else if (command === "add") {
	const labelIndex = args.indexOf("--label");
	const label = labelIndex === -1 ? (args[0] ?? "device") : (args[labelIndex + 1] ?? "device");
	const grantsIndex = args.indexOf("--grants");
	const grants = grantsFrom(grantsIndex === -1 ? undefined : args[grantsIndex + 1]);
	const minted = await mintToken(home, label, grants);
	console.log(`minted ${minted.record.id} for "${minted.record.label}":`);
	console.log();
	console.log(`  ${minted.token}`);
	console.log();
	console.log(
		"Open one of these once. The server sets a cookie and redirects, so the token does not stay in the URL:",
	);
	for (const url of pairingUrls(hostname, port, minted.token, 2)) console.log(`  ${url}`);
	console.log();
	console.log("An app client sends it as `Authorization: Bearer <token>` instead.");
	console.log("It is not stored in plain text anywhere: this is the only time it is shown.");
} else if (command === "grants") {
	const id = args[0];
	if (id === undefined) usage();
	const grants = grantsFrom(args[1] ?? "");
	if (grants === undefined) usage();
	const record = await setTokenGrants(home, id, grants);
	if (record === undefined) {
		console.error(`no token ${id}`);
		process.exit(1);
	}
	console.log(`${id} now grants ${grants.length === 0 ? "nothing" : grants.join(", ")}`);
} else if (command === "revoke") {
	const id = args[0];
	if (id === undefined) usage();
	if (await revokeToken(home, id)) console.log(`revoked ${id}`);
	else {
		console.error(`no token ${id}`);
		process.exit(1);
	}
} else {
	usage();
}
