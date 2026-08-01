// Regenerates frontend/emoji-data.json from the `unicode-emoji-json`
// devDependency. Run with `npm run emoji:generate`, not as part of the build:
// the output is committed so `npm test`, `npm run lint`, and CI need no
// pre-step, and Unicode only ships a new emoji set about once a year.
//
// The projection matters. The upstream file is 422 KiB because every entry
// carries a slug and two version fields the picker never reads; keeping only
// the character and its name gets the same 1914 emoji down to ~51 KiB (~17 KiB
// gzipped, which is what actually crosses the wire). Skin-tone
// variants are deliberately not expanded — the picker offers base forms only.
import groups from 'unicode-emoji-json/data-by-group.json' with { type: 'json' };
import { writeFile } from 'node:fs/promises';

const OUT = 'frontend/emoji-data.json';

// Deliberately unfiltered: this file is the newest Unicode set, and which of it
// counts as a usable reaction is decided at runtime, not here. The package
// tracks the latest Unicode release while `\p{RGI_Emoji}` comes from whatever
// version the *engine* was built against, and this script's Node is a third
// engine that is neither the browser drawing the picker nor the workerd
// validating the reaction. Filtering here would bake this machine's Unicode
// version into a committed file. `frontend/emoji-picker.js` filters on load
// instead, where the engine doing the filtering is the one doing the rendering.
//
// [group name, [[emoji, name], ...]] rather than objects: the picker reads
// these positionally and the array form is a third of the JSON.
const data = groups.map((group) => [group.name, group.emojis.map((e) => [e.emoji, e.name])]);

const count = data.reduce((n, [, emojis]) => n + emojis.length, 0);
const json = JSON.stringify(data) + '\n';

await writeFile(OUT, json);
const bytes = Buffer.byteLength(json, 'utf8');
console.log(`${OUT}: ${count} emoji in ${data.length} groups, ${bytes} bytes`);
