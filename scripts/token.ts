/**
 * `npm run token -- <add|list|revoke> …` — the credentials that may talk to mason.
 *
 * The token is printed once, when it is minted, and stored as a hash: losing it means minting another, which is the
 * property that makes a leaked `~/.mason/config.json` worth nothing.
 */
import { housePaths } from "../src/server/house.ts";
import { listTokens, mintToken, revokeToken } from "../src/server/auth.ts";

const [command, ...args] = process.argv.slice(2);
const home = housePaths().home;

function usage(): never {
	console.log(`usage:
  npm run token -- list
  npm run token -- add --label phone
  npm run token -- revoke <id>

  home: ${home}
  a running server reads its tokens at startup: restart it after a change.`);
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
	console.log("Open it once as `http://<host>:<port>/?token=<token>`, or send it as `Authorization: Bearer <token>`.");
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
