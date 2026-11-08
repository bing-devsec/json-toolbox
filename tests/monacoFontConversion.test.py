"""Maintenance-tool tests: python -B tests/monacoFontConversion.test.py.
Requires fonttools==4.61.1 and brotli==1.2.1; no browser or build output needed.
"""
from copy import deepcopy
from hashlib import sha256
from importlib.util import module_from_spec, spec_from_file_location
from io import BytesIO
from pathlib import Path
import unittest

spec = spec_from_file_location('convert_monaco_font', Path(__file__).resolve().parents[1] / 'scripts/convert-monaco-font.py')
converter = module_from_spec(spec)
spec.loader.exec_module(converter)


class MonacoFontConversionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source_bytes = converter.SOURCE.read_bytes()
        cls.baseline = converter.generate_woff2(cls.source_bytes, optimize=False)
        cls.optimized = converter.generate_woff2(cls.source_bytes)

    def font(self):
        font = converter.load_font(self.source_bytes)
        font['cmap'].tables = deepcopy(font['cmap'].tables)
        return font

    def table(self, font, key):
        return next(table for table in font['cmap'].tables if converter.cmap_key(table) == key)

    def assert_rejected(self, font, pattern):
        before = converter.cmap_signature(font)
        with self.assertRaisesRegex(ValueError, pattern):
            converter.prune_redundant_cmaps(font)
        self.assertEqual(converter.cmap_signature(font), before, 'Failed validation must not mutate the cmap')

    def test_full_font_is_deterministic_and_preserves_all_other_tables(self):
        self.assertEqual(sha256(self.baseline).hexdigest(), converter.BASELINE_SHA256)
        self.assertEqual(self.optimized, converter.generate_woff2(self.source_bytes))
        self.assertEqual(self.optimized, converter.DESTINATION.read_bytes())
        self.assertEqual(len(self.baseline), 36064)
        self.assertEqual(len(self.optimized), 34336)
        report = converter.validate_font(self.source_bytes, self.baseline, self.optimized)
        self.assertEqual((report['glyphs'], report['codepoints']), (462, 462))
        self.assertEqual(report['retainedCmaps'], [[0, 3, 4], [1, 0, 0], [3, 1, 4]])
        original = converter.load_font(self.source_bytes)
        optimized = converter.load_font(self.optimized)
        self.assertEqual(original.getGlyphOrder()[0], optimized.getGlyphOrder()[0])
        self.assertEqual(optimized.getBestCmap()[0xF101], original.getBestCmap()[0xF101])

    def test_missing_bmp_subtable_is_rejected(self):
        for key in [(0, 3, 4), (3, 1, 4)]:
            with self.subTest(key=key):
                font = self.font()
                font['cmap'].tables = [table for table in font['cmap'].tables if converter.cmap_key(table) != key]
                self.assert_rejected(font, 'BMP format-4')

    def test_missing_bmp_mapping_is_rejected(self):
        for key in [(0, 3, 4), (3, 1, 4)]:
            with self.subTest(key=key):
                font = self.font()
                table = self.table(font, key)
                table.cmap = dict(table.cmap)
                del table.cmap[0xEAB4]
                self.assert_rejected(font, 'not equivalent')

    def test_non_bmp_mapping_is_rejected(self):
        for key in [(0, 4, 12), (3, 10, 12)]:
            with self.subTest(key=key):
                font = self.font()
                table = self.table(font, key)
                table.cmap = {**table.cmap, 0x10000: 'chevron-down'}
                self.assert_rejected(font, 'Non-BMP')

    def test_non_equivalent_format12_mapping_is_rejected(self):
        for key in [(0, 4, 12), (3, 10, 12)]:
            with self.subTest(key=key):
                font = self.font()
                table = self.table(font, key)
                table.cmap = {**table.cmap, 0xEAB4: 'chevron-right'}
                self.assert_rejected(font, 'not equivalent')

    def test_language_mismatch_and_duplicate_record_are_rejected(self):
        font = self.font()
        self.table(font, (0, 4, 12)).language = 1
        self.assert_rejected(font, 'not equivalent')
        font = self.font()
        font['cmap'].tables.append(deepcopy(font['cmap'].tables[0]))
        self.assert_rejected(font, 'Duplicate cmap')

    def test_unexpected_layout_and_cross_platform_difference_are_rejected(self):
        font = self.font()
        self.table(font, (1, 0, 0)).platEncID = 1
        self.assert_rejected(font, 'Unexpected cmap layout')
        font = self.font()
        for key in [(3, 1, 4), (3, 10, 12)]:
            table = self.table(font, key)
            table.cmap = {**table.cmap, 0xEAB4: 'chevron-right'}
        self.assert_rejected(font, 'Windows BMP mappings differ')

    def test_validator_rejects_unrelated_metadata_or_head_change(self):
        for tag in ['name', 'head']:
            with self.subTest(tag=tag):
                font = converter.load_font(self.optimized)
                if tag == 'name':
                    font['name'].names[0].string = b'changed'
                else:
                    font['head'].unitsPerEm += 1
                buffer = BytesIO()
                font.save(buffer)
                with self.assertRaisesRegex(AssertionError, 'Unexpected decoded table change|Only head.checkSumAdjustment'):
                    converter.validate_font(self.source_bytes, self.baseline, buffer.getvalue())


if __name__ == '__main__':
    unittest.main()
