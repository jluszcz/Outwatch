// Bounds on a season's editable fields, shared by the Worker (which 400s past
// them) and the season form (whose number and text inputs enforce them), so an
// out-of-range value is caught by the browser before a request is spent on it.
//
// Loose on purpose: a season is usually added before its episode table settles
// on Wikipedia, so the count is a best guess that gets corrected later. The
// bounds only keep out typos, not unlikely-but-real seasons.
export const MAX_EPISODE_COUNT = 30;
export const MAX_SUBTITLE_LENGTH = 100;
