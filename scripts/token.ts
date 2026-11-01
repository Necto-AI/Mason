/**
 * `npm run token -- <add|list|revoke> …` — the credentials that may talk to mason.
 *
 * The token is printed once, when it is minted, and stored as a hash: losing it means minting another, which is the
 * property that makes a leaked `~/.mason/config.json` worth nothing. A running server reads the file per request, so a
 * revoke lands immediately — no restart, and no window where a lost phone still works.
 */

import { listTokens, mintToken, pairingUrls, revokeToken } from "../src/server/auth.ts";
import { housePaths } from "../src/server/house.ts";

const [command, ...args] = process.argv.slice(2);
const home = housePaths().home;
/** The address to print with a new token. A server started elsewhere will differ; the token is what matters. */
const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

function usage(): never {
	console.log(`usage:
  npm run token -- list
  npm run token -- add --label phone
  npm run token -- revoke <id>

  home: ${home}
  a running server reads its tokens per request: a revoke is live, without a restart.`);
	process.exit(command === undefined || command === "--help" ? 0 : 1);
}

if (command === "list") {
	const tokens = await listTokens(home);
	if (tokens.length === 0) console.log("no tokens");
	for (const token of tokens) {
		console.log(`${token.id}  ${token.label.padEnd(12)}  created ${token.createdAt}`);
	}
} else if (command === "add") {
	const labelIndex = args.indexOf("--label");
	const label = labelIndex === -1 ? (args[0] ?? "device") : (args[labelIndex + 1] ?? "device");
	const minted = await mintToken(home, label);
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
