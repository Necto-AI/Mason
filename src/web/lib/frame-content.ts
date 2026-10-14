// Adapted from `vendor/open-intelligent-ui/apps/app/src/components/generative-ui/open-generative-ui/frame-content.ts`
// (the trip animator is dropped: this client renders conversational widgets, not map trips).
import { FORM_STYLES_WITH_STAGGER_CSS, IMPORTMAP_SCRIPT_TAG, SVG_CLASSES_CSS, THEME_CSS } from "@repo/design-system";

export const RESIZE_MESSAGE_TYPE = "__ogui_resize";

export const PREVIEW_FRAME_CONTENT = "<head></head><body></body>";

const DESIGN_SYSTEM_CSS = `${THEME_CSS}\n${SVG_CLASSES_CSS}\n${FORM_STYLES_WITH_STAGGER_CSS}`;
const DESIGN_SYSTEM_STYLE_TAG = `<style>${DESIGN_SYSTEM_CSS}</style>`;
const OVERFLOW_HIDDEN_STYLE_TAG = "<style>html, body { overflow: hidden !important; }</style>";

/**
 * CSP for the final sandbox document: `unsafe-inline` covers the websandbox bootstrap and the scripts
 * `sandbox.run` injects; script and connect sources are limited to the CDN origins the importmap names.
 */
export const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="
    default-src 'self';
    script-src 'unsafe-inline' 'unsafe-eval'
      https://cdnjs.cloudflare.com
      https://esm.sh
      https://cdn.jsdelivr.net
      https://unpkg.com;
    style-src 'unsafe-inline';
    img-src 'self' data: blob: https://basemap.nationalmap.gov https://upload.wikimedia.org https://thumb.wikimedia.org;
    font-src 'self' data:;
    connect-src 'self'
      https://cdnjs.cloudflare.com
      https://esm.sh
      https://cdn.jsdelivr.net
      https://unpkg.com;
  ">`;

export function ensureHead(html: string): string {
	if (/<head[\s>]/i.test(html)) return html;
	return `<head></head>${html}`;
}

/** The settled document: CSP, importmap, design-system styles, the widget's css, then its html. */
export function buildFinalFrameContent(html: string, css?: string): string {
	const headContent =
		CSP_META_TAG + IMPORTMAP_SCRIPT_TAG + DESIGN_SYSTEM_STYLE_TAG + (css ? `<style>${css}</style>` : "");
	const withHead = ensureHead(html);
	const openTag = withHead.match(/<head[^>]*>/i);
	if (!openTag || openTag.index === undefined) return `<head>${headContent}</head>${withHead}`;
	const insertAt = openTag.index + openTag[0].length;
	return withHead.slice(0, insertAt) + headContent + withHead.slice(insertAt);
}

/** The streaming document's head: design-system styles, the css parameter, and complete `<style>` blocks. */
export function buildPreviewHeadContent(css?: string, previewStyles?: string): string {
	const parts = [OVERFLOW_HIDDEN_STYLE_TAG, DESIGN_SYSTEM_STYLE_TAG];
	if (css) parts.push(`<style>${css}</style>`);
	if (previewStyles) parts.push(previewStyles);
	return parts.join("");
}

/** Morph the streamed body into place (Idiomorph when present, `innerHTML` otherwise). */
export function buildPreviewBodyMorph(body: string): string {
	return `(function() {
  var html = ${JSON.stringify(body)};
  if (typeof Idiomorph !== "undefined" && Idiomorph && Idiomorph.morph) {
    try {
      Idiomorph.morph(document.body, html, {
        morphStyle: 'innerHTML',
        callbacks: {
          beforeNodeAdded: function(node) {
            if (node.nodeType === 1) {
              node.classList.add('morph-enter');
              node.addEventListener('animationend', function() {
                node.classList.remove('morph-enter');
              }, { once: true });
            }
          }
        }
      });
    } catch (err) {
      document.body.innerHTML = html;
    }
  } else {
    document.body.innerHTML = html;
  }
})();`;
}

/**
 * Fullscreen layout for a widget: it owns the viewport, so it fills the height and scrolls itself instead of
 * collapsing to its content height (which `MEASUREMENT_JS` pins down for the embedded case).
 */
export const FULLSCREEN_FRAME_JS = `
(function() {
  var id = '__oguiFullscreenStyle';
  if (document.getElementById(id)) return;
  var style = document.createElement('style');
  style.id = id;
  style.textContent = 'html, body { height: 100% !important; min-height: 100% !important; overflow: auto !important; }';
  document.head.appendChild(style);
  window.dispatchEvent(new Event('resize'));
})();`;

/** Back to the embedded layout: content height, no scrollbars of its own. */
export const EMBEDDED_FRAME_JS = `
(function() {
  var style = document.getElementById('__oguiFullscreenStyle');
  if (style !== null) style.remove();
  window.dispatchEvent(new Event('resize'));
})();`;

/** Continuous autosize: report the content height to the parent on every change. */
export const MEASUREMENT_JS = `
(function() {
  if (window.__oguiResizeInstalled) return;
  window.__oguiResizeInstalled = true;
  var style = document.createElement('style');
  style.textContent = 'html, body { overflow: hidden !important; height: auto !important; min-height: 0 !important; }';
  document.head.appendChild(style);
  function reportHeight() {
    var h = document.body.scrollHeight;
    var cs = getComputedStyle(document.body);
    h += parseFloat(cs.marginTop) || 0;
    h += parseFloat(cs.marginBottom) || 0;
    parent.postMessage({ type: '${RESIZE_MESSAGE_TYPE}', height: Math.ceil(h) }, '*');
  }
  var ro = new ResizeObserver(reportHeight);
  ro.observe(document.body);
  window.addEventListener('resize', reportHeight);
  window.addEventListener('load', reportHeight);
  var interval = setInterval(reportHeight, 200);
  setTimeout(function() { clearInterval(interval); }, 3000);
  reportHeight();
})();
`;
