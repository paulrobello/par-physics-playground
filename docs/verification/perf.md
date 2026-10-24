# Performance qualification (P5-T3, PRD G7)

Measured 2026-10-24, `main` at the P5-T3 commit, local hardware Chromium
(headed, `channel: "chromium"`, `--use-angle=metal --enable-gpu
--ignore-gpu-blocklist`, ProArt display at 120 Hz — the 120 fps readings are
the display cap, not a sim ceiling). Playwright perf config, 1 worker, 1000
measured rAF frames after 120 warmup frames, host-load guards ≤ 15 before
and after every sample (per the load-guarded measurement rule).

## Results

| Case | Bodies | Joints | fps | Load before → after |
|---|---|---|---|---|
| 200-box smoke | 200 | 0 | 120.0 | 6.82 → 7.56 |
| 500 mixed typical | 500 (6 materials, boxes+circles, settled stack) | 0 | 119.9–120.0 | 7.56 → 7.28 |
| 1000 machine stress | 1000 (620 loose + 60 cart bodies + 300 rope beads + 20 static beams) | 40 pins + 300 rope links | **50.3** | 9.89 → 8.71 |

Budgets: 60 fps at 500 typical (met at display cap), documented 45 fps floor
at the 1000 stress case (met at 50.3 fps).

## What it took

- **Sprite-cached body rendering** (`src/renderer.ts`): the per-body
  `shadowBlur` fill measured **14 fps at 200 bodies** when paid every frame —
  exactly the PRD R2 trap. Bodies now rasterize once per (shape, material,
  staticness, dpr) into offscreen sprites and blit per frame; re-rasterized
  on zoom drift > 30%, shape/material change, or document restore. Only the
  hovered body takes the live glow path; selection outlines stay live
  strokes.
- **Headed measurement**: headless Chromium throttles rAF (~14 Hz measured
  against 120 fps headed on the identical page) — `playwright.perf.config.ts`
  now runs headed. A timing harness must not measure the throttle.
- **D17 rope total guard raised 192 → 384** (`src/lib/rope.ts`): the mandated
  rope-heavy stress workload (300+ beads) exceeded the old provisional cap.
  Guards bound abuse, not the perf target (PRD D17 updated).

## Sim-only headroom (probe, not gate)

200 settled boxes: 0.18 ms/tick sim-only (all sleeping) via `advanceTime`
probe — rendering was the entire 14 fps regression; the sim has ~90×
headroom at the typical scale.
