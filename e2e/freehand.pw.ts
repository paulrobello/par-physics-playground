import { expect, test } from "@playwright/test";

/**
 * Freehand e2e (debug mode: real-time feed paused, `advanceTime` drives the
 * sim). Draws approximate shapes with the mouse and asserts, via the debug
 * API's bodyShape probe, that the committed colliders are the CLEANED
 * primitives: a drawn circle snaps to a circle body of the drawn radius, a
 * drawn rectangle to a box of the drawn dimensions, a drawn triangle to a
 * 3-vertex polygon, a concave blob keeps its silhouette (triangulated) and
 * rests stably, and an open stroke becomes a chain of thin box segments.
 */
test("freehand strokes snap to clean primitives and chains", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const stage = page.locator("#stage");
	const stageBox = await stage.boundingBox();
	if (!stageBox) throw new Error("stage canvas not visible");

	// Page coordinates for a world point, from the live camera state.
	const pagePos = async (
		wx: number,
		wy: number,
	): Promise<{ x: number; y: number }> => {
		const cam = await page.evaluate(() => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return ppg.cameraState();
		});
		return {
			x: stageBox.x + wx * cam.zoom + cam.offsetX,
			y: stageBox.y + wy * cam.zoom + cam.offsetY,
		};
	};

	// Draw one stroke: press, walk the sample points, release.
	const drawStroke = async (
		points: readonly { x: number; y: number }[],
	): Promise<void> => {
		const first = points[0];
		if (!first) throw new Error("empty stroke");
		const start = await pagePos(first.x, first.y);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		for (const p of points) {
			const q = await pagePos(p.x, p.y);
			await page.mouse.move(q.x, q.y, { steps: 2 });
		}
		await page.mouse.up();
	};

	await page.keyboard.press("f");
	expect(
		await page.locator('[data-tool="freehand"]').getAttribute("aria-pressed"),
	).toBe("true");

	// Circle: 24 samples on a ring of radius 30 at (150, -150).
	const circlePts: { x: number; y: number }[] = [];
	for (let i = 0; i <= 24; i++) {
		const a = (i / 24) * Math.PI * 2;
		circlePts.push({ x: 150 + 30 * Math.cos(a), y: -150 + 30 * Math.sin(a) });
	}
	await drawStroke(circlePts);

	// Rectangle: 60x40 corners at (250,-150).
	await drawStroke([
		{ x: 250, y: -150 },
		{ x: 310, y: -150 },
		{ x: 310, y: -110 },
		{ x: 250, y: -110 },
		{ x: 250, y: -150 },
	]);

	// Triangle at (400,-100).
	await drawStroke([
		{ x: 400, y: -100 },
		{ x: 460, y: -100 },
		{ x: 430, y: -160 },
		{ x: 400, y: -100 },
	]);

	// Concave blob: an L outline drawn in one closed stroke.
	await drawStroke([
		{ x: 550, y: -100 },
		{ x: 610, y: -100 },
		{ x: 610, y: -120 },
		{ x: 570, y: -120 },
		{ x: 570, y: -170 },
		{ x: 550, y: -170 },
		{ x: 550, y: -100 },
	]);

	// Open squiggle: five wavy points -> 4 chain segments.
	await drawStroke([
		{ x: 700, y: -150 },
		{ x: 720, y: -130 },
		{ x: 740, y: -150 },
		{ x: 760, y: -130 },
		{ x: 780, y: -150 },
	]);

	const ids = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyIds();
	});
	// circle + rect + triangle + blob + 4 chain segments.
	expect(ids).toHaveLength(8);
	const [circleId, rectId, triId, blobId, ...chainIds] = ids;
	if (!circleId || !rectId || !triId || !blobId || chainIds.length !== 4)
		throw new Error("expected 4 shapes plus a 4-segment chain");

	const shapes = await page.evaluate(
		({ circleId, rectId, triId, blobId }) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return {
				circle: ppg.bodyShape(circleId),
				rect: ppg.bodyShape(rectId),
				tri: ppg.bodyShape(triId),
				blob: ppg.bodyShape(blobId),
			};
		},
		{ circleId, rectId, triId, blobId },
	);

	// Circle: snapped primitive with the drawn radius (within 1.5).
	expect(shapes.circle?.kind).toBe("circle");
	if (shapes.circle?.kind === "circle")
		expect(Math.abs(shapes.circle.radius - 30)).toBeLessThan(1.5);

	// Rectangle: snapped box with the drawn dimensions.
	expect(shapes.rect?.kind).toBe("box");
	if (shapes.rect?.kind === "box") {
		expect(Math.abs(shapes.rect.halfWidth - 30)).toBeLessThan(1.5);
		expect(Math.abs(shapes.rect.halfHeight - 20)).toBeLessThan(1.5);
	}

	// Triangle: cleaned to exactly 3 vertices.
	expect(shapes.tri?.kind).toBe("polygon");
	if (shapes.tri?.kind === "polygon") expect(shapes.tri.points).toHaveLength(3);

	// Blob: keeps its freeform (concave) silhouette, more than 3 vertices.
	expect(shapes.blob?.kind).toBe("polygon");
	if (shapes.blob?.kind === "polygon")
		expect(shapes.blob.points.length).toBeGreaterThan(3);

	// Chain: every segment is a thin box.
	const chainShapes = await page.evaluate((chainIds) => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return chainIds.map((id) => ppg.bodyShape(id));
	}, chainIds);
	expect(chainShapes).toHaveLength(4);
	for (const s of chainShapes) {
		expect(s?.kind).toBe("box");
		if (s?.kind === "box") expect(s.halfHeight).toBeCloseTo(0.25, 5);
	}

	// Everything settles under gravity, the blob rests stably.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(10000);
	});
	const blobBefore = await page.evaluate(
		({ blobId }) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return {
				p: ppg.bodyPosition(blobId),
				rot: ppg.bodyRot(blobId),
				ids: ppg.bodyIds(),
			};
		},
		{ blobId },
	);
	if (!blobBefore.p) throw new Error("blob culled, not settled");
	expect(blobBefore.ids).toHaveLength(8);
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(5000);
	});
	const blobAfter = await page.evaluate(
		({ blobId }) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return { p: ppg.bodyPosition(blobId), rot: ppg.bodyRot(blobId) };
		},
		{ blobId },
	);
	if (!blobAfter.p) throw new Error("blob culled during stability check");
	expect(Math.abs(blobAfter.p.x - blobBefore.p.x)).toBeLessThan(0.01);
	expect(Math.abs(blobAfter.p.y - blobBefore.p.y)).toBeLessThan(0.01);
	expect(Math.abs((blobAfter.rot ?? 1) - (blobBefore.rot ?? 1))).toBeLessThan(
		0.001,
	);
});
