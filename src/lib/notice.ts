/**
 * Transient on-screen notice (PRD D17 "visible rejection" and kin general):
 * a single lazy-created status toast above the canvas bottom edge. The rope
 * caps (P4-T4) surface refusals here; any other silent-refusal path can
 * reuse it. DOM-only, never called from unit-tested pure code.
 */

let hideTimer: ReturnType<typeof setTimeout> | null = null;
const NOTICE_HIDE_MS = 3200;

export function showNotice(message: string): void {
	let el = document.getElementById("ppg-notice");
	if (!el) {
		el = document.createElement("div");
		el.id = "ppg-notice";
		el.setAttribute("role", "status");
		document.body.append(el);
	}
	el.textContent = message;
	el.classList.add("visible");
	if (hideTimer) clearTimeout(hideTimer);
	const node = el;
	hideTimer = setTimeout(() => {
		node.classList.remove("visible");
		hideTimer = null;
	}, NOTICE_HIDE_MS);
}
