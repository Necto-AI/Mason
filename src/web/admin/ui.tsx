/**
 * The panel's small vocabulary: a card, a field, a badge, a switch, and the sentence a refusal becomes.
 *
 * One file, because a control plane is mostly the same eight things arranged differently. The look lives in
 * `admin.css`; nothing here decides a colour.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode, useId, useState } from "react";

export function Card({
	title,
	note,
	actions,
	children,
	className,
}: {
	readonly title?: ReactNode;
	readonly note?: ReactNode;
	readonly actions?: ReactNode;
	readonly children: ReactNode;
	readonly className?: string;
}) {
	return (
		<section className={`card${className === undefined ? "" : ` ${className}`}`}>
			{title === undefined ? null : (
				<header className="card-head">
					<div>
						<h2>{title}</h2>
						{note === undefined ? null : <p className="card-note">{note}</p>}
					</div>
					{actions === undefined ? null : <div className="card-actions">{actions}</div>}
				</header>
			)}
			{children}
		</section>
	);
}

/**
 * A labelled control. The id is the field's own and is handed to the one control the field wraps, so the label is
 * associated by `htmlFor` rather than by nesting — which is also what keeps a screen reader from reading the hint as
 * part of the control's name.
 */
export function Field({
	label,
	hint,
	children,
	wide,
}: {
	readonly label: string;
	readonly hint?: string;
	readonly children: ReactNode;
	readonly wide?: boolean;
}) {
	const id = useId();
	const control =
		isValidElement(children) &&
		(children.type === "input" || children.type === "select" || children.type === "textarea")
			? cloneElement(children as ReactElement<{ id?: string }>, { id })
			: children;
	return (
		<div className={`field${wide === true ? " wide" : ""}`}>
			<label className="field-label" htmlFor={id}>
				{label}
			</label>
			{control}
			{hint === undefined ? null : <span className="field-hint">{hint}</span>}
		</div>
	);
}

export type Tone = "ok" | "warn" | "error" | "muted" | "accent";

export function Badge({ tone = "muted", children }: { readonly tone?: Tone; readonly children: ReactNode }) {
	return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Toggle({
	checked,
	onChange,
	label,
	disabled,
}: {
	readonly checked: boolean;
	readonly onChange: (next: boolean) => void;
	readonly label: string;
	readonly disabled?: boolean;
}) {
	return (
		<button
			type="button"
			className={`switch${checked ? " on" : ""}`}
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			<span className="switch-thumb" />
		</button>
	);
}

export function ErrorNote({ error }: { readonly error: string | undefined }) {
	if (error === undefined) return null;
	return (
		<p className="error-note" role="alert">
			{error}
		</p>
	);
}

/** A key/value line: an id in mono, a moment, a count. */
export function Fact({ label, value }: { readonly label: string; readonly value: ReactNode }) {
	return (
		<div className="fact">
			<span className="fact-label">{label}</span>
			<span className="fact-value">{value}</span>
		</div>
	);
}

/** A secret minted once: shown, selectable, and gone on the next state read. */
export function Once({ label, value }: { readonly label: string; readonly value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="once">
			<div className="once-head">
				<span>{label}</span>
				<button
					type="button"
					className="button ghost"
					onClick={() => {
						void navigator.clipboard?.writeText(value).then(
							() => setCopied(true),
							() => setCopied(false),
						);
					}}
				>
					{copied ? "copied" : "copy"}
				</button>
			</div>
			<code className="once-value">{value}</code>
			<p className="once-note">
				Shown once. Nothing in mason can print it again; a lost one is replaced, not recovered.
			</p>
		</div>
	);
}

/** `<details>` around a JSON payload: the trace is read, not scrolled past. */
export function Json({ label, value }: { readonly label: string; readonly value: unknown }) {
	if (value === undefined) return null;
	return (
		<details className="json">
			<summary>{label}</summary>
			<pre>{JSON.stringify(value, null, 2)}</pre>
		</details>
	);
}

/** The sentence a refusal becomes, and the one button that clears it. */
export function useAction(onDone?: () => void): {
	readonly pending: boolean;
	readonly error: string | undefined;
	readonly run: (action: () => Promise<unknown>) => Promise<void>;
	readonly clear: () => void;
} {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	return {
		pending,
		error,
		async run(action) {
			setPending(true);
			setError(undefined);
			try {
				await action();
				onDone?.();
			} catch (reason) {
				setError(reason instanceof Error ? reason.message : String(reason));
			} finally {
				setPending(false);
			}
		},
		clear: () => setError(undefined),
	};
}
