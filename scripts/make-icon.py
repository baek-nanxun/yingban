from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
size = 1024
scale = size / 256
image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
def p(values): return tuple(round(value * scale) for value in values)
def w(value): return max(1, round(value * scale))

draw.rounded_rectangle(p((0, 0, 256, 256)), radius=round(54 * scale), fill='#f4d9cb')
draw.rounded_rectangle(p((34, 42, 188, 158)), radius=round(22 * scale), fill='#fffaf5', outline='#b95f40', width=w(13))
draw.line([p((94, 158)), p((94, 185))], fill='#b95f40', width=w(13))
draw.line([p((67, 201)), p((148, 201))], fill='#b95f40', width=w(13))
draw.rounded_rectangle(p((119, 103, 231, 195)), radius=round(27 * scale), fill='#c76748', outline='#fffaf5', width=w(9))
draw.polygon([p((166, 183)), p((166, 213)), p((191, 183))], fill='#c76748')
draw.line([p((151, 132)), p((189, 132))], fill='#fffaf5', width=w(8))
draw.line([p((151, 148)), p((176, 148))], fill='#fffaf5', width=w(8))
image.save(ROOT / 'app/icon.ico', format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
image.resize((256, 256), Image.Resampling.LANCZOS).save(ROOT / 'app/icon-preview.png', format='PNG')
print(ROOT / 'app/icon.ico')
