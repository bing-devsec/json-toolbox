"""Optional font maintenance: fonttools==4.61.1 brotli==1.2.1.

Run from any directory; --write regenerates only the reviewed complete WOFF2.
No glyph subsetting: remove only two redundant format-12 cmap subtables, whose
entire BMP mappings also exist in the retained format-4 subtables. Every other
decoded font table stays byte-identical to the original complete WOFF2, except
the head checksum. Keep the upstream license beside the font.

Use --raster-check for an additional optional Pillow/FreeType pixel comparison.
That check is not a browser test. No browser/network measurement is claimed.
"""
import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path

import brotli
import fontTools
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables.DefaultTable import DefaultTable

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf'
DESTINATION = ROOT / 'assets/fonts/codicon-0.52.2.woff2'
SOURCE_SHA256 = '0f1d5219934e96e83b8db162d60b4d8c09b5de1e7d38031cbafe4a3c0f2889c9'
BASELINE_SHA256 = '9b3fdf002aa8d8e75869bb2017d80838a7665dc83ef7818c5f4ffe4e812b69a6'
REDUNDANT_CMAPS = {(0, 4, 12), (3, 10, 12)}


def load_font(data):
    # options.recalc_bounds alone does not prevent glyf bounding-box changes.
    # The source's original bounds must survive, including its broad xMin values.
    return TTFont(BytesIO(data), recalcTimestamp=False, recalcBBoxes=False)


def cmap_key(table):
    return table.platformID, table.platEncID, table.format


def cmap_signature(font):
    return [(cmap_key(table), table.language, sorted(table.cmap.items()))
            for table in font['cmap'].tables]


def prune_redundant_cmaps(font):
    """Fail closed unless both UCS-4 maps are exact copies of full BMP maps."""
    tables = font['cmap'].tables
    by_key = {cmap_key(table): table for table in tables}
    if len(by_key) != len(tables):
        raise ValueError('Duplicate cmap platform/encoding/format records require review.')
    pairs = [((0, 3, 4), (0, 4, 12)), ((3, 1, 4), (3, 10, 12))]
    for bmp_key, full_key in pairs:
        if bmp_key not in by_key or full_key not in by_key:
            raise ValueError('Both complete BMP format-4 maps and their format-12 maps are required.')
        bmp, full = by_key[bmp_key], by_key[full_key]
        if any(not 0 <= cp <= 0xFFFF for cp in set(bmp.cmap) | set(full.cmap)):
            raise ValueError('Non-BMP codepoints require the format-12 cmap; refusing to remove it.')
        if not bmp.cmap or bmp.cmap != full.cmap or bmp.language != full.language:
            raise ValueError('Format-12 cmap is not equivalent to its complete BMP format-4 map.')
    if by_key[(0, 3, 4)].cmap != by_key[(3, 1, 4)].cmap:
        raise ValueError('Unicode and Windows BMP mappings differ; review the font.')
    if set(by_key) != {(0, 3, 4), (0, 4, 12), (1, 0, 0), (3, 1, 4), (3, 10, 12)}:
        raise ValueError('Unexpected cmap layout; review the font before changing it.')
    font['cmap'].tables = [table for table in tables if cmap_key(table) not in REDUNDANT_CMAPS]


def generate_woff2(source_bytes, *, optimize=True):
    font = load_font(source_bytes)
    if optimize:
        prune_redundant_cmaps(font)
        font.getGlyphOrder()
        # cmap decoding loads post. Preserve even its original padding/packing,
        # instead of letting a normal recompile alter unrelated name data.
        post = DefaultTable('post')
        post.data = font.reader['post']
        font['post'] = post
    font.flavor = 'woff2'
    buffer = BytesIO()
    font.save(buffer)
    return buffer.getvalue()


def validate_font(source_bytes, baseline_bytes, converted_bytes):
    baseline_raw, converted_raw = load_font(baseline_bytes), load_font(converted_bytes)
    assert set(baseline_raw.reader.keys()) == set(converted_raw.reader.keys()), 'Font tables changed'
    identical_tables = []
    for tag in baseline_raw.reader.keys():
        before, after = baseline_raw.reader[tag], converted_raw.reader[tag]
        if tag == 'cmap':
            continue  # Its exact allowed structural change is checked below.
        if tag == 'head':
            assert before[:8] + before[12:] == after[:8] + after[12:], 'Only head.checkSumAdjustment may change'
        else:
            assert before == after, f'Unexpected decoded table change: {tag}'
            identical_tables.append(tag)

    original, baseline, converted = map(load_font, (source_bytes, baseline_bytes, converted_bytes))
    expected_cmaps = [signature for signature in cmap_signature(baseline)
                     if signature[0] not in REDUNDANT_CMAPS]
    assert cmap_signature(converted) == expected_cmaps, 'Retained cmap records/mappings changed'
    assert original.getGlyphOrder() == converted.getGlyphOrder(), 'Glyphs/order changed'
    assert original.getBestCmap() == converted.getBestCmap(), 'Codepoint mappings changed'
    assert original['hmtx'].metrics == converted['hmtx'].metrics, 'Glyph metrics changed'
    assert original['head'].unitsPerEm == converted['head'].unitsPerEm
    # Preserve the original source-to-WOFF2 table proof too. cmap alone now has
    # a separately checked semantic change; all other original checks remain.
    for tag in set(original.keys()) - {'GlyphOrder', 'head', 'loca', 'glyf', 'cmap'}:
        assert original.getTableData(tag) == converted.getTableData(tag), tag
    old_glyphs, new_glyphs = original.getGlyphSet(), converted.getGlyphSet()
    for name in original.getGlyphOrder():
        before, after = RecordingPen(), RecordingPen()
        old_glyphs[name].draw(before)
        new_glyphs[name].draw(after)
        assert before.value == after.value, name
        left = getattr(original['glyf'][name], 'program', None)
        right = getattr(converted['glyf'][name], 'program', None)
        assert (left.getBytecode() if left else b'') == (right.getBytecode() if right else b''), name
    return {
        'glyphs': len(original.getGlyphOrder()), 'codepoints': len(original.getBestCmap()),
        'identicalDecodedTables': sorted(identical_tables),
        'allowedTableChanges': {
            'cmap': 'Only duplicate (0,4,format12)/(3,10,format12) removed; all retained records and mappings equal.',
            'head': 'Only checkSumAdjustment at bytes 8-11 differs.',
        },
        'retainedCmaps': [list(cmap_key(table)) for table in converted['cmap'].tables],
    }


def check_rasters(baseline_bytes, converted_bytes):
    import PIL
    from PIL import ImageFont, features

    codepoints = load_font(baseline_bytes).getBestCmap()
    sizes = [12, 14, 16, 20, 24, 32, 48, 64]
    for size in sizes:
        before = ImageFont.truetype(BytesIO(baseline_bytes), size=size)
        after = ImageFont.truetype(BytesIO(converted_bytes), size=size)
        for cp in codepoints:
            text = chr(cp)
            left, right = before.getmask(text), after.getmask(text)
            assert before.getbbox(text) == after.getbbox(text), (size, cp, 'bounds')
            assert before.getlength(text) == after.getlength(text), (size, cp, 'advance')
            assert left.size == right.size and bytes(left) == bytes(right), (size, cp, 'pixels')
    return {
        'pillow': PIL.__version__, 'freeType': features.version('freetype2'),
        'fontFormatLoaded': 'WOFF2 directly, without conversion to TTF',
        'codepoints': len(codepoints), 'sizes': sizes, 'comparisons': len(codepoints) * len(sizes),
        'result': 'All raster masks, bounds and advances equal. This is not a browser test.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--raster-check', action='store_true')
    args = parser.parse_args()
    source_bytes = SOURCE.read_bytes()
    assert sha256(source_bytes).hexdigest() == SOURCE_SHA256, 'Review the installed Monaco font first'
    baseline_bytes = generate_woff2(source_bytes, optimize=False)
    assert sha256(baseline_bytes).hexdigest() == BASELINE_SHA256, 'Use the reviewed FontTools/Brotli versions for reproducible output'
    regenerated = generate_woff2(source_bytes)
    validation = validate_font(source_bytes, baseline_bytes, regenerated)
    assert generate_woff2(source_bytes) == regenerated, 'WOFF2 regeneration must be deterministic'
    if args.write:
        DESTINATION.write_bytes(regenerated)
    converted_bytes = DESTINATION.read_bytes()
    assert regenerated == converted_bytes, 'Committed WOFF2 differs; review and regenerate with --write'
    report = {
        **validation,
        'sourceBytes': len(source_bytes), 'woff2Bytes': len(converted_bytes),
        'sourceSha256': SOURCE_SHA256, 'woff2Sha256': sha256(converted_bytes).hexdigest(),
        'baselineCompleteWoff2': {'bytes': len(baseline_bytes), 'sha256': BASELINE_SHA256},
        'savedBytes': len(baseline_bytes) - len(converted_bytes),
        'generator': {'fontTools': fontTools.__version__, 'brotli': brotli.__version__},
        'result': 'All glyphs, outlines, metrics, mappings, instructions and unrelated decoded tables preserved; deterministic regeneration verified.',
    }
    if args.raster_check:
        report['rasterValidation'] = check_rasters(baseline_bytes, converted_bytes)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
