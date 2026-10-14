/**
 * The inline widget renderer for `generateSandboxedUi`, adapted from
 * `vendor/open-intelligent-ui/apps/app/src/components/generative-ui/open-generative-ui/renderer.tsx`.
 *
 * While the model streams the tool call, a preview sandbox shows the markup as it arrives (css first, then a morphed
 * body). Once the arguments are settled, a second sandbox loads the complete document — CSP, importmap, design-system
 * styles — and runs the widget's behavior. Buttons inside the widget reach the agent through the host bridge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IDIOMORPH_JS } from "../lib/idiomorph-inline.ts";
import {
	buildFinalFrameContent,
	buildPreviewBodyMorph,
	buildPreviewHeadContent,
	MEASUREMENT_JS,
	PREVIEW_FRAME_CONTENT,
	RESIZE_MESSAGE_TYPE,
} from "../lib/frame-content.ts";
import type { OpenGenUIContent } from "../lib/open-genui-content.ts";
import { extractCompleteStyles, processPartialHtml } from "../lib/process-partial-html.ts";
import { loadWebsandbox, type SandboxInstance, type WidgetBridge } from "../lib/websandbox-loader.ts";

export const THROTTLE_MS = 1000;
const MIN_HEIGHT = 50;
const MAX_HEIGHT = 4000;

/** Clamp a reported height; anything that is not a finite number is ignored. */
export function clampReportedHeight(height: unknown): number | null {
	if (typeof height !== "number" || !Number.isFinite(height)) return null;
	return Math.max(MIN_HEIGHT, Math.min(Math.ceil(height), MAX_HEIGHT));
}

export const FALLBACK_PHRASES = [
	"Sketching pixels",
	"Wiring up nodes",
	"Painting gradients",
	"Compiling visuals",
];

function shouldFlushImmediately(previous: OpenGenUIContent | null, next: OpenGenUIContent): boolean {
	if (next.cssComplete && (previous === null || previous.cssComplete !== true)) return true;
	if (next.htmlComplete) return true;
	if (next.generating === false) return true;
	if (next.jsFunctions !== undefined && (previous === null || previous.jsFunctions === undefined)) return true;
	if ((next.jsExpressions?.length ?? 0) > (previous?.jsExpressions?.length ?? 0)) return true;
	if ((next.html?.length ?? 0) > 0 && (previous?.html?.length ?? 0) === 0) return true;
	return false;
}

function styleIframe(iframe: HTMLIFrameElement): void {
	iframe.style.width = "100%";
	iframe.style.height = "100%";
	iframe.style.border = "none";
	iframe.style.backgroundColor = "transparent";
}

export interface SandboxedUiCardProps {
	content: OpenGenUIContent;
	bridge: WidgetBridge;
	/** `true` while the model is still streaming the call; parts of `content` are then incomplete. */
	streaming: boolean;
}

export function SandboxedUiCard({ content, bridge, streaming }: SandboxedUiCardProps) {
	const [throttled, setThrottled] = useState(content);
	const [previous, setPrevious] = useState(content);
	const latest = useRef(content);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Synchronous state adjustment during render, as in the adapted component: immediate flushes reach the
	// sandbox in the same pass.
	if (content !== previous) {
		setPrevious(content);
		if (shouldFlushImmediately(throttled, content)) setThrottled(content);
	}

	useEffect(() => {
		latest.current = content;
	});

	const flush = useCallback(() => {
		timer.current = null;
		setThrottled(latest.current);
	}, []);

	useEffect(() => {
		if (throttled === content) {
			if (timer.current !== null) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			return;
		}
		if (timer.current === null) timer.current = setTimeout(flush, THROTTLE_MS);
	}, [content, throttled, flush]);

	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);

	return <SandboxedUiFrame content={throttled} bridge={bridge} streaming={streaming} />;
}

type SandboxState = "idle" | "creating" | "ready" | "failed";

function SandboxedUiFrame({ content, bridge, streaming }: SandboxedUiCardProps) {
	const initialHeight = content.initialHeight ?? 200;
	// The bridge is rebuilt on every parent render, so the sandbox holds a stable forwarder instead: a changing
	// `localApi` identity would tear the iframe down and lose the widget's own state.
	const bridgeRef = useRef(bridge);
	bridgeRef.current = bridge;
	const stableBridge = useRef<WidgetBridge>({
		sendPrompt: (args) => bridgeRef.current.sendPrompt(args),
		openLink: (args) => bridgeRef.current.openLink(args),
	}).current;
	const [autoHeight, setAutoHeight] = useState<number | null>(null);
	const [sandboxState, setSandboxState] = useState<SandboxState>("idle");

	const localApi = useMemo(() => {
		const api: Record<string, (args: unknown) => unknown> = {};
		api.sendPrompt = (args) => stableBridge.sendPrompt(args as { text: string });
		api.openLink = (args) => stableBridge.openLink(args as { url: string });
		return api;
	}, [stableBridge]);

	const fullHtml =
		content.htmlComplete === true && (content.html?.length ?? 0) > 0 ? content.html?.join("") : undefined;
	const css = content.cssComplete === true ? content.css : undefined;

	const cssReady = content.cssComplete === true;
	const partialHtml =
		content.htmlComplete !== true && (content.html?.length ?? 0) > 0 ? content.html?.join("") : undefined;
	const previewBody = partialHtml === undefined ? undefined : processPartialHtml(partialHtml);
	const previewStyles = partialHtml === undefined ? "" : extractCompleteStyles(partialHtml);
	const hasPreview = cssReady && (previewBody?.trim().length ?? 0) > 0;
	const hasVisibleSandbox = fullHtml !== undefined || hasPreview;

	const containerRef = useRef<HTMLDivElement>(null);
	const finalSandbox = useRef<SandboxInstance | null>(null);
	const previewSandbox = useRef<SandboxInstance | null>(null);
	const previewReady = useRef(false);
	const finalReady = useRef(false);
	const executedExpressions = useRef(0);
	const pending = useRef<string[]>([]);
	const jsFunctionsInjected = useRef(false);

	// Preview sandbox: created once css is complete and some markup exists.
	useEffect(() => {
		const container = containerRef.current;
		if (container === null || fullHtml !== undefined || !hasPreview || previewSandbox.current !== null) return;
		let cancelled = false;
		loadWebsandbox()
			.then((Websandbox) => {
				if (cancelled) return;
				const sandbox = Websandbox.create(
					{},
					{ frameContainer: container, frameContent: PREVIEW_FRAME_CONTENT, allowAdditionalAttributes: "" },
				);
				previewSandbox.current = sandbox;
				styleIframe(sandbox.iframe);
				sandbox.promise.then(() => {
					if (cancelled) return;
					previewReady.current = true;
					sandbox.run(IDIOMORPH_JS);
					sandbox.run(
						`document.head.innerHTML = ${JSON.stringify(buildPreviewHeadContent(css, previewStyles))}`,
					);
					if (previewBody !== undefined) sandbox.run(buildPreviewBodyMorph(previewBody));
				});
			})
			.catch((error: unknown) => console.error("[gen-ui] preview sandbox failed:", error));
		return () => {
			cancelled = true;
		};
	}, [hasPreview, fullHtml]); // eslint-disable-line react-hooks/exhaustive-deps

	// Preview updates: the head follows css, the body is morphed.
	useEffect(() => {
		const sandbox = previewSandbox.current;
		if (sandbox === null || !previewReady.current) return;
		sandbox.run(`document.head.innerHTML = ${JSON.stringify(buildPreviewHeadContent(css, previewStyles))}`);
		if (previewBody !== undefined) sandbox.run(buildPreviewBodyMorph(previewBody));
	}, [previewBody, previewStyles, css]);

	// Final sandbox: the complete document, with the host bridge.
	useEffect(() => {
		const container = containerRef.current;
		if (container === null || fullHtml === undefined) return;
		if (previewSandbox.current !== null) {
			previewSandbox.current.destroy();
			previewSandbox.current = null;
			previewReady.current = false;
		}
		let cancelled = false;
		executedExpressions.current = 0;
		jsFunctionsInjected.current = false;
		finalReady.current = false;
		pending.current = [];
		setSandboxState("creating");

		const onMessage = (event: MessageEvent) => {
			const sandbox = finalSandbox.current;
			if (sandbox === null) return;
			if (event.source === sandbox.iframe.contentWindow && (event.data as { type?: string })?.type === RESIZE_MESSAGE_TYPE) {
				const height = clampReportedHeight((event.data as { height?: unknown }).height);
				if (height !== null) setAutoHeight(height);
			}
		};
		window.addEventListener("message", onMessage);

		loadWebsandbox()
			.then((Websandbox) => {
				if (cancelled) return;
				const sandbox = Websandbox.create(localApi, {
					frameContainer: container,
					frameContent: buildFinalFrameContent(fullHtml, css),
					allowAdditionalAttributes: "",
				});
				finalSandbox.current = sandbox;
				styleIframe(sandbox.iframe);
				sandbox.promise.then(() => {
					if (cancelled) return;
					finalReady.current = true;
					setSandboxState("ready");
					sandbox.run(MEASUREMENT_JS);
					const queued = pending.current;
					pending.current = [];
					void (async () => {
						for (const code of queued) await sandbox.run(code);
					})();
				});
			})
			.catch((error: unknown) => {
				setSandboxState("failed");
				console.error("[gen-ui] final sandbox failed:", error);
			});

		return () => {
			cancelled = true;
			window.removeEventListener("message", onMessage);
			finalSandbox.current?.destroy();
			finalSandbox.current = null;
			finalReady.current = false;
			setAutoHeight(null);
		};
	}, [fullHtml, css, localApi]);

	// Behavior: injected once the final sandbox is ready, queued before it.
	useEffect(() => {
		if (content.jsFunctions === undefined || jsFunctionsInjected.current) return;
		jsFunctionsInjected.current = true;
		const sandbox = finalSandbox.current;
		if (finalReady.current && sandbox !== null) {
			void sandbox.run(content.jsFunctions).catch((error: unknown) => {
				console.error("[gen-ui] behavior failed:", error);
			});
		} else pending.current.push(content.jsFunctions);
	}, [content.jsFunctions]);

	// Expressions: run in arrival order, each awaited.
	useEffect(() => {
		const expressions = content.jsExpressions;
		if (expressions === undefined || expressions.length === 0) return;
		const start = executedExpressions.current;
		if (start >= expressions.length) return;
		const next = expressions.slice(start);
		executedExpressions.current = expressions.length;
		const sandbox = finalSandbox.current;
		if (finalReady.current && sandbox !== null) {
			void (async () => {
				for (const expression of next) await sandbox.run(expression);
			})();
		} else {
			pending.current.push(...next);
		}
	}, [content.jsExpressions]);

	const height = autoHeight ?? initialHeight;
	const showLoading = streaming && !hasVisibleSandbox;

	return (
		<div className="genui" data-testid="genui-card">
			<div className="genui-toolbar" data-testid="genui-status">
				<span className={`badge ${streaming ? "badge-live" : "badge-done"}`}>
					{streaming ? "GEN-UI • streaming" : "GEN-UI • settled"}
				</span>
				{content.placeholderMessages === undefined || !showLoading ? null : (
					<span className="genui-hint">{content.placeholderMessages[0]}</span>
				)}
			</div>
			<div
				ref={containerRef}
				className={`genui-frame ${hasVisibleSandbox ? "genui-frame-live" : ""}`}
				data-testid="genui-frame"
				data-sandbox-state={sandboxState}
				style={{ height: `${height}px` }}
			>
				{showLoading ? (
					<div className="genui-loading">
						<span className="spinner" />
						<span>{content.placeholderMessages?.[0] ?? FALLBACK_PHRASES[0]}…</span>
					</div>
				) : null}
			</div>
		</div>
	);
}
