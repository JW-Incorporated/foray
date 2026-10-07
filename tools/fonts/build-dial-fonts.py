#!/usr/bin/env python3
"""Rebuild the three Tactile ("Dial") web fonts under fonts/ from the prototype's
Google Fonts Latin slices. Not run in CI; run it only when the recipe changes.

    pip install fonttools brotli
    python tools/fonts/build-dial-fonts.py

Recipe (docs/redesign-2026/directions/tactile/BUILD-PLAN.md section 1.1):

  fonts/dial-display-latin.woff2  Big Shoulders, instanced to wght 700-800 (opsz
      axis kept), hhea/OS-2 ascent = 84% and descent = 24% of the em so the ink sits
      centred in the line box on WebKit too (WebKit ignores @font-face
      ascent-override), renamed "DialDisplay".
  fonts/dial-text-latin.woff2     Bricolage Grotesque, instanced to wght 500-700,
      wdth pinned at 100, opsz 12-40 kept, renamed "DialText".
  fonts/azeret-mono-latin.woff2   Azeret Mono, copied untouched.

All three are SIL OFL 1.1. A re-cut or instanced file is a Modified Version, so it
ships under a new family name whether or not the upstream copy reserves one (the
upstream OFL.txt files for Big Shoulders and Bricolage Grotesque carry no Reserved
Font Name line, checked 2026-10-06). Licence notice: fonts/LICENSES.md.
"""
import os
import shutil
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
SRC = os.path.join(ROOT, "docs", "redesign-2026", "directions", "tactile", "prototype", "fonts")
OUT = os.path.join(ROOT, "fonts")


def rename(font, family, ps):
    name = font["name"]
    for rec in list(name.names):
        if rec.nameID in (16, 17, 21, 22, 25):
            name.removeNames(nameID=rec.nameID)
    for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
        name.setName(family, 1, pid, eid, lid)
        name.setName("Regular", 2, pid, eid, lid)
        name.setName(f"{ps};dial-modified", 3, pid, eid, lid)
        name.setName(family, 4, pid, eid, lid)
        name.setName(ps, 6, pid, eid, lid)


def save(font, path):
    font.flavor = "woff2"
    font.save(path)
    print(f"{os.path.relpath(path, ROOT)}: {os.path.getsize(path)} bytes")


def build_display():
    f = TTFont(os.path.join(SRC, "big-shoulders-latin.woff2"))
    f = instancer.instantiateVariableFont(f, {"wght": (700, 800)})
    upm = f["head"].unitsPerEm
    asc, desc = round(upm * 0.84), round(upm * 0.24)
    f["hhea"].ascent, f["hhea"].descent, f["hhea"].lineGap = asc, -desc, 0
    os2 = f["OS/2"]
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = asc, -desc, 0
    os2.usWinAscent, os2.usWinDescent = asc, desc
    os2.fsSelection |= 1 << 7  # USE_TYPO_METRICS
    rename(f, "DialDisplay", "DialDisplay-Variable")
    save(f, os.path.join(OUT, "dial-display-latin.woff2"))


def build_text():
    f = TTFont(os.path.join(SRC, "bricolage-grotesque-latin.woff2"))
    f = instancer.instantiateVariableFont(f, {"wght": (500, 700), "wdth": 100, "opsz": (12, 40)})
    rename(f, "DialText", "DialText-Variable")
    save(f, os.path.join(OUT, "dial-text-latin.woff2"))


def build_mono():
    dst = os.path.join(OUT, "azeret-mono-latin.woff2")
    shutil.copyfile(os.path.join(SRC, "azeret-mono-latin.woff2"), dst)
    print(f"{os.path.relpath(dst, ROOT)}: {os.path.getsize(dst)} bytes")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    build_display()
    build_text()
    build_mono()
    sys.exit(0)
