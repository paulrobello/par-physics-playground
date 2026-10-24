/**
 * App entry point: boots the Canvas2D renderer into the D15 HUD skeleton.
 */
import "./style.css";
import { debugEnabled } from "./debug";
import { createRenderer } from "./renderer";

const stage = document.querySelector<HTMLCanvasElement>("#stage");
if (!stage) throw new Error("#stage canvas missing from index.html");
// tsgo does not carry const narrowing into closures; alias with an explicit type.
const canvas: HTMLCanvasElement = stage;

const renderer = createRenderer(canvas);

function fit(): void {
	const rect = canvas.getBoundingClientRect();
	renderer.resize(rect.width, rect.height);
}

const observer = new ResizeObserver(fit);
observer.observe(canvas);
fit();
renderer.start();

if (debugEnabled) {
	console.info("[par-physics] debug mode enabled");
}
