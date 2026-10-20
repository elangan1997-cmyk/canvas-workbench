import importlib.util
import tempfile
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('tiles', root / 'scripts/prepare_text_tiles.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as work:
    source = Path(work) / '原始 长图.png'
    image = Image.new('RGB', (900, 2100))
    for y in range(image.height):
        for x in range(image.width):
            image.putpixel((x, y), (x % 256, y % 256, (x + y) % 256))
    image.save(source)
    region = {'x': 20, 'y': 50, 'width': 850, 'height': 2000}
    result = module.prepare({'input': str(source), 'output': work, 'crops': [region]})
    assert result['width'] == 900 and result['height'] == 2100
    assert len(result['tiles']) == 4
    covered = set()
    for tile in result['tiles']:
        part = Image.open(tile['path'])
        x, y, w, h = (tile[k] for k in ('x', 'y', 'width', 'height'))
        assert part.size == (w, h)
        assert part.tobytes() == image.crop((x, y, x + w, y + h)).tobytes()
        assert x >= 20 and y >= 50 and x + w <= 870 and y + h <= 2050
        covered.update(range(y, y + h))
    assert covered == set(range(50, 2050))
    # A medium selection from this long image is one call, even when it
    # exceeds the dense-page core height. Pixels outside it are never sent.
    result = module.prepare({'input': str(source), 'output': work, 'crops': [{'x': 30, 'y': 1100, 'width': 820, 'height': 900}]})
    assert len(result['tiles']) == 1
    tile = result['tiles'][0]
    assert (tile['x'], tile['y'], tile['width'], tile['height']) == (30, 1100, 820, 900)
    assert Image.open(tile['path']).tobytes() == image.crop((30, 1100, 850, 2000)).tobytes()
    # Two separate user selections remain separate; never bridge their gap.
    result = module.prepare({'input': str(source), 'output': work, 'crops': [
        {'x': 20, 'y': 100, 'width': 500, 'height': 100},
        {'x': 20, 'y': 1700, 'width': 500, 'height': 100}]})
    assert len(result['tiles']) == 2
    assert [(t['y'], t['height']) for t in result['tiles']] == [(100, 100), (1700, 100)]
    # Wide selections need horizontal tiles as well.
    wide = Image.new('RGB', (3000, 600))
    wide.save(source)
    result = module.prepare({'input': str(source), 'output': work, 'crops': [{'x': -5, 'y': 0, 'width': 3010, 'height': 700}]})
    assert len(result['tiles']) == 4
    assert result['tiles'][-1]['x'] + result['tiles'][-1]['width'] == 3000
    # A wide short heading is also direct.
    result = module.prepare({'input': str(source), 'output': work, 'crops': [{'x': 0, 'y': 0, 'width': 2300, 'height': 200}]})
    assert len(result['tiles']) == 1
print('source pixels preserved; source bounds and full selected coverage verified')
