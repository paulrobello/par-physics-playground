/**
 * Clamp a value into [min, max]. Bounds are inclusive.
 */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
