#!/usr/bin/env python3
"""Builds the icon assets: src/assets/icons/material-symbols-rounded.json (every icon
SkyView uses as SVG paths, which is what renders) and
src/assets/fonts/material-symbols-rounded.woff2 (Material Symbols Rounded cut down
to the same icons, a fallback for any icon that isn't registered as SVG).

The full variable font is ~5.4 MB with ~3,800 icons; phones often gave up on it
and showed icon names as text. This keeps every axis (FILL, wght, GRAD, opsz) but
only the needed ligatures, so it's a small fraction of the size.

    python3 scripts/build-icon-font.py           rebuild if the icon list changed
    python3 scripts/build-icon-font.py --force   always rebuild
    python3 scripts/build-icon-font.py --check   exit 1 if the font is out of date

Icon names are found by scanning src/ (and the m3e components the app imports)
for string literals that are Material Symbols ligatures, so dynamic names like
`name=${v.icon}` are covered as long as the name appears somewhere as a string.

Runs before `npm run dev` / `npm run build`, and the dev server re-runs it when
a source file changes. Needs fontTools plus woff2_compress / woff2_decompress
(Arch: pacman -S python-fonttools woff2; Debian/Ubuntu: apt install
python3-fonttools woff2). Without them the committed font is kept and any
missing icons are reported.
"""
import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'node_modules/material-symbols/material-symbols-rounded.woff2'
OUT_DIR = ROOT / 'src/assets/fonts'
OUT = OUT_DIR / 'material-symbols-rounded.woff2'
LIST = OUT_DIR / 'material-symbols-rounded.icons.txt'  # what's in the font + a hash stamp
SVGS = ROOT / 'src/assets/icons/material-symbols-rounded.json'  # name -> [outlined, filled] SVG paths
M3E = ROOT / 'node_modules/@m3e/web/dist'

TOKEN = re.compile(r"""['"`]([a-z0-9_]{2,})['"`]|name=["']([a-z0-9_]{2,})["']""")


def log(msg):
    print(f'[icon-font] {msg}')


def used_m3e_modules():
    """The m3e component modules main.ts imports, e.g. '@m3e/web/dialog' -> dialog.js."""
    main = (ROOT / 'src/main.ts').read_text()
    names = set(re.findall(r"@m3e/web/([a-z-]+)", main)) | {'core'}
    return [M3E / f'{n}.js' for n in sorted(names) if (M3E / f'{n}.js').exists()]


def candidate_names():
    files = [p for p in (ROOT / 'src').rglob('*') if p.suffix in ('.ts', '.js', '.html', '.css')]
    files += [ROOT / 'index.html'] + used_m3e_modules()
    found = set()
    for f in files:
        for a, b in TOKEN.findall(f.read_text(errors='ignore')):
            found.add(a or b)
    return found


def tool(name):
    path = shutil.which(name)
    if not path:
        raise FileNotFoundError(name)
    return path


def load_source_ttf(tmp: Path):
    """woff2 -> ttf with the woff2 CLI (fontTools needs the brotli module for that)."""
    src = tmp / 'full.woff2'
    shutil.copy(SOURCE, src)
    subprocess.run([tool('woff2_decompress'), str(src)], check=True, capture_output=True)
    from fontTools.ttLib import TTFont
    return TTFont(str(tmp / 'full.ttf'))


def ligatures(font):
    """Yields (name, first_glyph, ligature) for every icon ligature in GSUB."""
    rev = {g: chr(u) for u, g in font.getBestCmap().items()}
    for lookup in font['GSUB'].table.LookupList.Lookup:
        for st in lookup.SubTable:
            st = getattr(st, 'ExtSubTable', st)
            if getattr(st, 'LookupType', None) != 4:
                continue
            for first, ligs in st.ligatures.items():
                for lig in ligs:
                    chars = [rev.get(g) for g in [first, *lig.Component]]
                    if all(chars):
                        yield ''.join(chars), first, lig


def build(keep):
    from fontTools import subset
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        font = load_source_ttf(tmp)
        available = {name for name, _, _ in ligatures(font)}
        keep = sorted(keep & available)
        wanted = set(keep)
        # Drop every ligature that isn't one of our icons, so the subsetter's glyph
        # closure only pulls in the icons we need.
        for lookup in font['GSUB'].table.LookupList.Lookup:
            for st in lookup.SubTable:
                st = getattr(st, 'ExtSubTable', st)
                if getattr(st, 'LookupType', None) != 4:
                    continue
                rev = {g: chr(u) for u, g in font.getBestCmap().items()}
                for first in list(st.ligatures):
                    st.ligatures[first] = [
                        lig for lig in st.ligatures[first]
                        if ''.join(rev.get(g, '\0') for g in [first, *lig.Component]) in wanted
                    ]
                    if not st.ligatures[first]:
                        del st.ligatures[first]
        opts = subset.Options()
        opts.layout_features = ['*']
        opts.name_IDs = ['*']
        opts.notdef_outline = True
        opts.glyph_names = False
        sub = subset.Subsetter(opts)
        letters = {ord(c) for name in keep for c in name}
        sub.populate(unicodes=letters)
        sub.subset(font)
        ttf = tmp / 'subset.ttf'
        font.save(str(ttf))
        export_svgs(ttf, keep)
        subprocess.run([tool('woff2_compress'), str(ttf)], check=True, capture_output=True)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp / 'subset.woff2'), OUT)
        return keep


def export_svgs(ttf, keep):
    """Every icon as SVG path data, outlined (FILL 0) and filled (FILL 1).

    m3e-icon renders registered icons as SVG instead of font text, which sits
    exactly in its 1em box on every platform (iOS drew the font glyphs offset).
    Paths use Material's standard viewBox "0 -960 960 960": the font's 960-unit
    em with y flipped.
    """
    import json
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer

    def num(v):
        return f'{v:.1f}'.rstrip('0').rstrip('.')

    paths = {name: ['', ''] for name in keep}
    for i, fill in enumerate((0, 1)):
        font = instancer.instantiateVariableFont(
            TTFont(str(ttf)), {'FILL': fill, 'wght': 400, 'GRAD': 0, 'opsz': 24})
        glyphs = font.getGlyphSet()
        # Filled icons are separate glyphs ("home" -> "home.fill") that the font
        # swaps in through a FILL-conditional single substitution (rclt).
        swap = {}
        if fill:
            for lookup in font['GSUB'].table.LookupList.Lookup:
                if lookup.LookupType == 1:
                    for st in lookup.SubTable:
                        swap.update(st.mapping)
        for name, _first, lig in ligatures(font):
            if name in paths:
                pen = SVGPathPen(glyphs, ntos=num)
                glyph = swap.get(lig.LigGlyph, lig.LigGlyph)
                glyphs[glyph].draw(TransformPen(pen, (1, 0, 0, -1, 0, 0)))
                paths[name][i] = pen.getCommands()
    SVGS.parent.mkdir(parents=True, exist_ok=True)
    SVGS.write_text(json.dumps({k: v for k, v in sorted(paths.items()) if v[0]}, separators=(',', ':')) + '\n')


def stamp(keep):
    src_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()[:16] if SOURCE.exists() else 'none'
    return hashlib.sha256((src_hash + '\n' + '\n'.join(sorted(keep))).encode()).hexdigest()


def read_list():
    if not LIST.exists():
        return None, set()
    lines = LIST.read_text().splitlines()
    stamp_line = next((l for l in lines if l.startswith('# stamp ')), '')
    return stamp_line[8:], {l for l in lines if l and not l.startswith('#')}


def main():
    force, check = '--force' in sys.argv, '--check' in sys.argv
    candidates = candidate_names()
    old_stamp, shipped = read_list()

    # The stamp covers every candidate string (not just real icons), so any new
    # string literal triggers a rebuild; the rebuild works out which are icons.
    want_stamp = stamp(candidates)
    if OUT.exists() and SVGS.exists() and old_stamp == want_stamp and not force:
        return 0
    if check:
        log('icon font is out of date — run: python3 scripts/build-icon-font.py')
        return 1
    try:
        keep = build(candidates)
    except (FileNotFoundError, ModuleNotFoundError, subprocess.CalledProcessError) as e:
        missing = sorted(n for n in candidates if n not in shipped) if shipped else []
        log(f"can't rebuild ({e}) — keeping the existing font")
        if missing:
            log('these strings are not in the committed font (fine unless they are icons): ' + ', '.join(missing[:40]))
        return 0
    LIST.write_text(
        '# Generated by scripts/build-icon-font.py — icons included in material-symbols-rounded.woff2\n'
        f'# stamp {want_stamp}\n' + '\n'.join(keep) + '\n'
    )
    log(f'built {OUT.relative_to(ROOT)}: {len(keep)} icons, {OUT.stat().st_size // 1024} KB '
        f'(full font: {SOURCE.stat().st_size // 1024} KB) + SVGs ({SVGS.stat().st_size // 1024} KB)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
