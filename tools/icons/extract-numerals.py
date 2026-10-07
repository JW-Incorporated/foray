"""Extract the numerals the back-15 / forward-30 glyphs need, as outlines.

Why this exists: BUILD-NOTES section 2 says the numeral is "DM Sans 600 converted to
outlines". A `<text>` element in a sprite loaded through an external `<use>` does not see
the page's @font-face (the sprite is its own document), so it would render in a fallback
face. Outlines are font-independent and strict-CSP safe.

One-off, not part of CI. Output is committed as dm-sans-600-numerals.json and read by
build-sprite.mjs. Needs fontTools + brotli (pip install fonttools brotli).

    python -I tools/icons/extract-numerals.py fonts/dm-sans-variable.woff2 tools/icons/dm-sans-600-numerals.json

Instance: wght 600, opsz 14 (the text optical size; the glyphs are drawn at 36px or
less on screen, where the low-opsz cut is the sturdier one).
"""
import sys, json
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen

src, dst = sys.argv[1], sys.argv[2]
font = TTFont(src)
loc = {'wght': 600}
for axis in font['fvar'].axes:
    if axis.axisTag == 'opsz':
        loc['opsz'] = 14
inst = instancer.instantiateVariableFont(font, loc)
glyphs = inst.getGlyphSet()
cmap = inst.getBestCmap()
out = {'font': 'DM Sans (OFL) wght 600 opsz 14', 'upm': inst['head'].unitsPerEm, 'glyphs': {}}
for ch in '1530':
    g = glyphs[cmap[ord(ch)]]
    pen = SVGPathPen(glyphs, ntos=lambda v: ('%.2f' % v).rstrip('0').rstrip('.'))
    g.draw(pen)
    out['glyphs'][ch] = {'adv': g.width, 'd': pen.getCommands()}
with open(dst, 'w', newline='\n') as fh:
    fh.write(json.dumps(out, indent=1) + '\n')
