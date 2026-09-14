// The owner map's base style (API.md clarification 54, DECISIONS 62). OpenFreeMap's public vector tiles by default; the MAP_STYLE_URL
// Worker variable overrides it, so moving to self-hosted tiles later is a config change, not a code change.
export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'

export const mapStyleUrl = env => (typeof env?.MAP_STYLE_URL === 'string' && env.MAP_STYLE_URL.trim()) || DEFAULT_MAP_STYLE_URL
