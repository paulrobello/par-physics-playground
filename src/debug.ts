/**
 * `?debug=1` URL flag. P1 adds the deterministic-inspection hooks that consume
 * this; today it is parsed and stored only.
 */
export function isDebugEnabled(
	search: string = window.location.search,
): boolean {
	return new URLSearchParams(search).get("debug") === "1";
}

export const debugEnabled: boolean = isDebugEnabled();
