/**
 * The pending tool questions, answered from the control plane.
 *
 * A question is what the gateway asked before a call could run (`src/server/permissions.ts`): the tool, the arguments,
 * the reason and the two answers. Answering here is the same act as answering from a chat — the first authorized answer
 * settles it, a later one changes nothing, and there is no "always allow", which is an administrative decision made on
 * the connectors page rather than a button in a prompt.
 */
import type { PanelPermission } from "../../../shared/admin.ts";
import { Badge, Card, ErrorNote, Json, useAction } from "../ui.tsx";

function asked(unanswered: PanelPermission): string {
	if (unanswered.askedAt === null) return "no clock";
	return new Date(unanswered.askedAt).toLocaleString();
}

function toolName(tool: PanelPermission["tool"]): string {
	const parts = [tool.connector, tool.tool].filter((part) => part !== undefined);
	return parts.length === 0 ? tool.name : `${tool.name} · ${parts.join("/")}`;
}

export function Approvals({
	permissions,
	onAnswer,
}: {
	readonly permissions: readonly PanelPermission[];
	readonly onAnswer: (permissionId: string, answer: "allow" | "deny") => Promise<unknown>;
}) {
	const action = useAction();
	return (
		<Card
			title="Approvals"
			note="What the gateway is waiting on. Nothing runs until it is answered here, from the chat the question came from, or stopped."
			actions={<Badge tone={permissions.length === 0 ? "muted" : "warn"}>{permissions.length} waiting</Badge>}
		>
			<ErrorNote error={action.error} />
			{permissions.length === 0 ? (
				<p className="empty">Nothing is waiting for an answer.</p>
			) : (
				<div className="questions">
					{permissions.map((permission) => (
						<article className="question" key={permission.permissionId}>
							<header>
								<code>{toolName(permission.tool)}</code>
								<span className="faint">{asked(permission)}</span>
							</header>
							<p className="question-reason">{permission.reason}</p>
							<Json label="arguments" value={permission.arguments} />
							{permission.origin === null ? null : <Json label="origin" value={permission.origin} />}
							<footer>
								<button
									type="button"
									className="button primary"
									disabled={action.pending}
									onClick={() => void action.run(() => onAnswer(permission.permissionId, "allow"))}
								>
									Allow once
								</button>
								<button
									type="button"
									className="button danger"
									disabled={action.pending}
									onClick={() => void action.run(() => onAnswer(permission.permissionId, "deny"))}
								>
									Deny
								</button>
								<span className="faint mono">{permission.permissionId}</span>
							</footer>
						</article>
					))}
				</div>
			)}
		</Card>
	);
}
