/**
 * The join screen: the one question a shared browser asks before it starts speaking.
 *
 * A roster is a list of names, not accounts — whoever holds the invite link may claim any of them — so there is nothing
 * to fill in and nothing to verify. The reader picks the name their teammates will read, the server writes it into the
 * cookie, and the page opens the conversation again so the socket carries the name. An empty roster is not an error: it
 * is an install where nobody has been added yet, and naming the command that adds the first person is the whole screen.
 */
import { useState } from "react";
import { claimPerson, type SessionPerson } from "../lib/session.ts";

export interface PickerProps {
	readonly roster: readonly SessionPerson[];
}

export function Picker({ roster }: PickerProps) {
	const [claiming, setClaiming] = useState<string | undefined>(undefined);
	const [failure, setFailure] = useState<string | undefined>(undefined);

	const claim = async (name: string) => {
		setClaiming(name);
		setFailure(undefined);
		const result = await claimPerson(name);
		if (!result.ok) {
			setClaiming(undefined);
			setFailure(
				result.reason === "refused"
					? `${name} is not on the roster any more. Ask the deployer, or pick another name.`
					: "The server did not answer. Try again in a moment.",
			);
			return;
		}
		// The person is fixed at the socket's handshake, so the conversation has to be opened again to carry the name.
		// `replace`, not `assign`: the picker is a step, not a place worth coming back to.
		window.location.replace("/");
	};

	return (
		<div id="app">
			<div id="main">
				<div className="join" data-testid="picker">
					<h1>Who are you?</h1>
					<p>
						Pick your name. Every message you send will say who sent it, and the agent will know who decided what.
					</p>
					{roster.length === 0 ? (
						<p data-testid="picker-empty">
							Nobody is on the roster yet. On the machine that runs the agent, add the first person:{" "}
							<code>npm run team -- add "Ilya"</code>.
						</p>
					) : (
						<ul className="join-people">
							{roster.map((person) => (
								<li key={person.name}>
									<button
										type="button"
										data-testid="picker-person"
										disabled={claiming !== undefined}
										aria-busy={claiming === person.name}
										onClick={() => void claim(person.name)}
									>
										<span className="name">{person.name}</span>
									</button>
								</li>
							))}
						</ul>
					)}
					{failure === undefined ? null : (
						// biome-ignore lint/a11y/useSemanticElements: a styled paragraph, not the result of a calculation
						<p className="join-failed" role="status" data-testid="picker-failed">
							{failure}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
