/** The jump-to-latest pill: floats over the composer's top edge while the reader is scrolled away from the end. */
export interface JumpPillProps {
	readonly show: boolean;
	readonly running: boolean;
	readonly onClick: () => void;
}

export function JumpPill({ show, running, onClick }: JumpPillProps) {
	return (
		<button
			id="latest"
			type="button"
			className={show ? "show" : ""}
			data-testid="jump-pill"
			onClick={onClick}
			title="Jump to the latest"
		>
			{running ? (
				<span className="jump-ring" />
			) : (
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth={2}
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M12 5v14" />
					<path d="m19 12-7 7-7-7" />
				</svg>
			)}
			<span>Jump to latest</span>
		</button>
	);
}
