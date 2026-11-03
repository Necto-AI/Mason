/**
 * Who is in the room.
 *
 * The roster is the list of names the agent attributes words to (`src/server/roster.ts`): a connector maps its own
 * external actors onto these names, and a message carries one only because the server wrote it. Removing a person does
 * not delete a message — it ends the claim, and an actor mapped onto them starts being refused by the connector door.
 */
import { useState } from "react";
import type { PanelPerson } from "../../../shared/admin.ts";
import { Card, ErrorNote, useAction } from "../ui.tsx";

export function Roster({
	people,
	onAdd,
	onRemove,
	refresh,
}: {
	readonly people: readonly PanelPerson[];
	readonly onAdd: (name: string) => Promise<unknown>;
	readonly onRemove: (name: string) => Promise<unknown>;
	readonly refresh: () => Promise<void>;
}) {
	const [name, setName] = useState("");
	const action = useAction();
	return (
		<Card
			title="Roster"
			note="Names mason will attribute to. A connector's actor mapping points at these; approval authority is granted separately."
		>
			<ErrorNote error={action.error} />
			<table className="table">
				<thead>
					<tr>
						<th>name</th>
						<th>added</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{people.length === 0 ? (
						<tr>
							<td colSpan={3} className="empty">
								Nobody is on the roster yet. The agent can still work; no message will name a person.
							</td>
						</tr>
					) : (
						people.map((person) => (
							<tr key={person.name}>
								<td>{person.name}</td>
								<td className="faint">{new Date(person.addedAt).toLocaleString()}</td>
								<td>
									<button
										type="button"
										className="button ghost danger-text"
										disabled={action.pending}
										onClick={() =>
											void action.run(async () => {
												await onRemove(person.name);
												await refresh();
											})
										}
									>
										remove
									</button>
								</td>
							</tr>
						))
					)}
				</tbody>
			</table>
			<div className="row-inline">
				<input
					value={name}
					placeholder="Ilya"
					onChange={(event) => setName(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || name.trim() === "") return;
						void action.run(async () => {
							await onAdd(name.trim());
							setName("");
							await refresh();
						});
					}}
				/>
				<button
					type="button"
					className="button primary"
					disabled={action.pending || name.trim() === ""}
					onClick={() =>
						void action.run(async () => {
							await onAdd(name.trim());
							setName("");
							await refresh();
						})
					}
				>
					Add a person
				</button>
			</div>
		</Card>
	);
}
