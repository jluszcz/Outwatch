import { h } from 'preact';
import htm from 'htm';
import {
    Bell,
    ChevronLeft,
    MessageCircle,
    MoreHorizontal,
    Moon,
    Pencil,
    Reply,
    Sun,
    Trash2,
    X,
} from 'lucide-preact';

const html = htm.bind(h);

// Lucide (ISC), imported per icon from a `sideEffects: false` ESM package, so
// esbuild drops the other ~6,000 exports. Nothing is inlined here and no build
// plugin is involved — the package is ordinary ESM, which is also why the test
// suites resolve it with no vitest wiring at all.
//
// One glyph per name and no dark-mode variant. Lucide is stroke-drawn, so
// there is no solid twin to swap to — and none is wanted: an outline at a
// brighter colour matches light mode's weight more closely than a filled glyph
// does, which overshoots it. Dark mode is therefore a pure colour change,
// handled entirely by `light-dark()` in styles.css, and no component needs to
// know which theme is in effect in order to draw an icon.
const ICONS = {
    dots: MoreHorizontal,
    x: X,
    chevronLeft: ChevronLeft,
    chat: MessageCircle,
    reply: Reply,
    pencil: Pencil,
    trash: Trash2,
    bell: Bell,
    sun: Sun,
    moon: Moon,
};

// Painted with `currentColor` (Lucide's default) so a glyph inherits its
// button's colour — the delete row's red hover included — without a token of
// its own. `size={null}` drops Lucide's own width/height attributes so `.bi`'s
// em sizing decides the box, the way it did for the inlined paths. Always
// aria-hidden: every caller labels the control it sits in.
export function Icon({ name }) {
    const Glyph = ICONS[name];
    return html`<${Glyph} class="bi" size=${null} aria-hidden="true" focusable="false" />`;
}
