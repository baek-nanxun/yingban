from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json

root = Path(__file__).resolve().parents[1]
output = Path(__import__('os').environ.get('YINGBAN_OUTPUT_DIR', str(root.parents[1] / 'output' / 'yingban')))
output.mkdir(parents=True, exist_ok=True)
portable = root / 'dist' / 'YingBan-Windows'
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
app_zip = output / f'YingBan-Windows-{version}.zip'
with ZipFile(app_zip, 'w', ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(portable.rglob('*')):
        if file.is_file():
            archive.write(file, Path('YingBan-Windows') / file.relative_to(portable))
source_zip = output / f'YingBan-source-{version}.zip'
ignored = {'node_modules', 'dist', 'test-results', '.git', '__pycache__'}
with ZipFile(source_zip, 'w', ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(root.rglob('*')):
        rel = file.relative_to(root)
        # The release directory is normally inside the checkout. Exclude it
        # so the source archive cannot include the portable archive currently
        # being written and grow recursively until the runner runs out of disk.
        if file.is_file() and not file.is_relative_to(output) and not any(part in ignored for part in rel.parts) and rel.parts[:2] != ('native', 'bin'):
            archive.write(file, Path('YingBan-source') / rel)
artifacts = []
for file in (app_zip, source_zip):
    with ZipFile(file) as archive:
        assert archive.testzip() is None, 'Archive CRC check failed'
    artifacts.append({'file': file.name, 'bytes': file.stat().st_size, 'sha256': hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()})
(output / 'checksums.json').write_text(json.dumps(artifacts, indent=2), encoding='utf-8')
print(json.dumps(artifacts, indent=2))
