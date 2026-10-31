#!/usr/bin/env python3
"""Check the actual bundled font, including GB2312 and Big5 Han coverage."""
import hashlib
import json
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
FONT = ROOT / 'packages/app/resources/fonts/NotoSansCJKsc-Regular.otf'
meta = json.loads(FONT.with_name('NotoSansCJK-provenance.json').read_text())
b = FONT.read_bytes()
assert hashlib.sha256(b).hexdigest() == meta['sha256'], 'Font does not match pinned source'
u16 = lambda p: struct.unpack_from('>H', b, p)[0]
u32 = lambda p: struct.unpack_from('>I', b, p)[0]
tables = {b[12 + i * 16:16 + i * 16]: u32(20 + i * 16) for i in range(u16(4))}
base = tables[b'cmap']
covered = set()
for i in range(u16(base + 2)):
    platform, encoding, offset = struct.unpack_from('>HHI', b, base + 4 + i * 8)
    if platform != 0 and (platform, encoding) not in ((3, 1), (3, 10)):
        continue
    p = base + offset
    if u16(p) == 12:
        for j in range(u32(p + 12)):
            first, last, glyph = struct.unpack_from('>III', b, p + 16 + j * 12)
            covered.update(range(first + (glyph == 0), last + 1))
    elif u16(p) == 4:
        count = u16(p + 6) // 2
        ends = p + 14
        starts = ends + 2 * count + 2
        deltas = starts + 2 * count
        ranges = deltas + 2 * count
        for j in range(count):
            delta, offset = u16(deltas + j * 2), u16(ranges + j * 2)
            for code in range(u16(starts + j * 2), u16(ends + j * 2) + 1):
                glyph = u16(ranges + j * 2 + offset + 2 * (code - u16(starts + j * 2))) if offset else code
                if (not offset or glyph) and (glyph + delta) & 65535:
                    covered.add(code)

report = {'font_sha256': meta['sha256'], 'mapped_codepoints': len(covered)}
for encoding in ('gb2312', 'big5'):
    han = set()
    for a in range(0x81, 0xff):
        for z in range(0x40, 0xff):
            try:
                text = bytes((a, z)).decode(encoding)
            except UnicodeDecodeError:
                continue
            han.update(ord(c) for c in text if 0x3400 <= ord(c) <= 0x9fff)
    missing = sorted(han - covered)
    report[encoding] = {'han': len(han), 'missing': len(missing)}
    assert not missing, f'{encoding} missing: {missing[:20]}'
assert set(map(ord, '中文简体繁體字幕测试測試你好世界，。！？「」ABCxyz0123456789')) <= covered
print(json.dumps(report, ensure_ascii=False, indent=2))
