/**
 * A `generateSandboxedUi` call in the flow: bare, at the position the call has in the bubble, in live turns and
 * settled ones alike. The card itself is the adapted OpenIntelligentUI renderer; this only places it.
 */
import { useMemo } from "react";
import { contentFromToolCall } from "../lib/open-genui-content.ts";
import type { WidgetPiece } from "../lib/transcript-model.ts";
import type { WidgetBridge } from "../lib/websandbox-loader.ts";
import { SandboxedUiCard } from "./SandboxedUiCard.tsx";

export interface WidgetCardProps {
	readonly piece: WidgetPiece;
	readonly bridgeFor: (callId: string) => WidgetBridge;
	readonly debug?: boolean;
}

export function WidgetCard({ piece, bridgeFor, debug }: WidgetCardProps) {
	// The bridge and the content keep their identity per call, so a parent render never restarts the sandbox.
	const bridge = useMemo(() => bridgeFor(piece.callId), [bridgeFor, piece.callId]);
	const content = useMemo(() => contentFromToolCall(piece.args, !piece.streaming), [piece.args, piece.streaming]);
	return (
		<div className={`widget${debug === true ? " debug" : ""}`} data-testid="widget" data-call-id={piece.callId}>
			<SandboxedUiCard content={content} bridge={bridge} streaming={piece.streaming} />
		</div>
	);
}
