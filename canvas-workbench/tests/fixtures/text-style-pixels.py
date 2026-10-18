"""Independent ground-truth rasters, not snapshots of implementation output."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from PIL import Image, ImageDraw, ImageFont
from infer_text_style import infer_block, font_candidates

cases = [('文字大小与颜色', True, 64, '#D93127', '#F7F6F2'),
         ('TYPE RESTORE 2026', False, 48, '#3779AC', '#EFEFEF'),
         ('白色文字还原', True, 38, '#FCF9F1', '#143242'),
         ('超大标题', True, 280, '#191D20', '#FEFEFE')]
if not font_candidates(True) or not font_candidates(False):
    print('No supported installed fonts for pixel fixtures'); sys.exit(77)
for text, cjk, size, color, bg in cases:
    family, ps, weight, path = font_candidates(cjk)[2 if size >= 64 else 0]
    font = ImageFont.truetype(path, size)
    bounds = font.getbbox(text, anchor='ls')
    w, h = bounds[2]-bounds[0], bounds[3]-bounds[1]
    image = Image.new('RGB', (w+100, h+100), bg)
    ImageDraw.Draw(image).text((40-bounds[0], 40-bounds[1]), text, font=font, anchor='ls', fill=color)
    raw = dict(text=text, x=34, y=34, width=w+12, height=h+12, fontSize=size*0.65, color='#000000')
    item = infer_block(image, raw)
    assert abs(item['fontSize'] - size) / size < .035, (size, item)
    assert item['color'].lower() == color.lower(), item
    assert item['fontPostScript'] == ps, item
    fit = item['textFit']
    fitted_font = ImageFont.truetype(path, round(item['fontSize']))
    glyph = fitted_font.getbbox(text, anchor='ls')
    # Baseline must place the visible ink near its original top edge.
    assert abs(raw['y']+fit['baselineOffset']+glyph[1]-40) < 5, fit
    assert item['styleConfidence'] >= .85, item
    if size > 220: assert item['fontSize'] > 220

image = Image.new('RGB', (200, 100), 'white')
raw = dict(text='uncertain', x=0, y=0, width=190, height=80, fontSize=33,
           fontPostScript='Inter-Bold', color='#ABCDEF', rotation=15, textAlign='right', enabled=False)
item = infer_block(image, raw)
for key, value in raw.items(): assert item[key] == value
assert 'textFit' not in item
print('4 known raster fixtures and uncertain rotated row passed')
