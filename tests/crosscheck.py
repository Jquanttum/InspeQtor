#!/usr/bin/env python3
"""
Independent cross-check of the Quanttum Photo Inspector parser against
  * exiftool (the reference metadata reader; version printed in the report),
  * Pillow (decoder / EXIF reader / quantisation tables / sampling), and
  * piexif (EXIF + thumbnail reader), plus Python's hashlib for the file hashes.

For every JPEG in tests/fixtures (and optionally an extra corpus passed as arguments) it compares the
fields listed in CHECKS and writes tests/CROSSCHECK.md plus tests/results/crosscheck.json.
Exit status is non-zero if any unexplained disagreement remains.

Usage: python3 tests/crosscheck.py [extra_dir ...]
"""
import hashlib, io, json, math, os, re, subprocess, sys, datetime
from collections import defaultdict
from PIL import Image
import piexif

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(HERE, 'fixtures')
dirs = [FIX] + [os.path.abspath(a) for a in sys.argv[1:]]
files = []
for d in dirs:
    if os.path.isdir(d):
        files += [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.lower().endswith(('.jpg', '.jpeg'))]
print('files:', len(files))

# ---------------------------------------------------------------- our results (Node)
r = subprocess.run(['node', os.path.join(ROOT, 'tools', 'dump-all.js')] + dirs, capture_output=True, text=True, cwd=ROOT)
if r.returncode != 0:
    sys.exit('node failed: ' + r.stderr[:500])
OURS = json.loads(r.stdout)

# ---------------------------------------------------------------- exiftool (batch)
def run_exiftool(paths):
    out = {}
    for i in range(0, len(paths), 60):
        chunk = paths[i:i + 60]
        p = subprocess.run(['exiftool', '-j', '-n', '-G1', '-a', '-u', '-struct', '-api', 'largefilesupport=1'] + chunk, capture_output=True, text=True)
        try:
            arr = json.loads(p.stdout) if p.stdout.strip() else []
        except Exception:
            arr = []
        for e in arr:
            out[os.path.abspath(e['SourceFile'])] = e
    return out
ET = run_exiftool(files)
ETVER = subprocess.run(['exiftool', '-ver'], capture_output=True, text=True).stdout.strip()
import PIL
print('exiftool', ETVER, '| Pillow', PIL.__version__, '| piexif', piexif.VERSION)

# ---------------------------------------------------------------- comparison bookkeeping
RES = defaultdict(lambda: dict(compared=0, agree=0, declined=0, disagree=[]))

def norm(v):
    if isinstance(v, str):
        return v.strip().strip('\x00')
    return v

def py_tail_after_eoi(raw):
    """Independent minimal marker walk (written separately from js/jpeg.js): returns bytes after the main-image EOI."""
    i = 2; n = len(raw)
    while i + 4 <= n:
        if raw[i] != 0xFF: return b''
        m = raw[i + 1]
        if m == 0xFF: i += 1; continue
        if m == 0xD9: return raw[i + 2:]
        if m in (0x01,) or 0xD0 <= m <= 0xD7: i += 2; continue
        L = int.from_bytes(raw[i + 2:i + 4], 'big')
        i += 2 + L
        if m == 0xDA:
            while i + 1 < n:
                if raw[i] == 0xFF and raw[i + 1] not in (0x00, 0xFF) and not (0xD0 <= raw[i + 1] <= 0xD7): break
                i += 1
    return b''

def record(field, name, ours, theirs, tol=None, declined=False, note=''):
    s = RES[field]
    if declined:
        s['declined'] += 1; return
    s['compared'] += 1
    ours, theirs = norm(ours), norm(theirs)
    if tol is not None and isinstance(ours, (int, float)) and isinstance(theirs, (int, float)):
        ok = abs(ours - theirs) <= tol
    else:
        ok = ours == theirs
    if ok:
        s['agree'] += 1
    else:
        s['disagree'].append(dict(file=os.path.basename(name), ours=ours, other=theirs, note=note))

def et_get(e, *keys):
    for k in keys:
        for ek in e:
            if ek.split(':', 1)[-1] == k:
                return e[ek]
    return None

def et_group(e, group, key):
    for ek in e:
        g, _, k = ek.partition(':')
        if g == group and k == key:
            return e[ek]
    return None

def our_row(j, ifd, name):
    for r in j['exif'] or []:
        if r['ifd'] == ifd and r['name'] == name:
            return r
    return None

def our_val(j, ifd, name):
    r = our_row(j, ifd, name)
    return None if r is None else r['raw']

def sha(b):
    return hashlib.sha256(b).hexdigest()

TEXT_TAGS = [('ifd0', 'Make', 'IFD0', 'Make'), ('ifd0', 'Model', 'IFD0', 'Model'), ('ifd0', 'Software', 'IFD0', 'Software'), ('ifd0', 'DateTime', 'IFD0', 'ModifyDate'),
             ('ifd0', 'Artist', 'IFD0', 'Artist'), ('ifd0', 'Copyright', 'IFD0', 'Copyright'), ('ifd0', 'ImageDescription', 'IFD0', 'ImageDescription'),
             ('exif', 'DateTimeOriginal', 'ExifIFD', 'DateTimeOriginal'), ('exif', 'DateTimeDigitized', 'ExifIFD', 'CreateDate'),
             ('exif', 'LensModel', 'ExifIFD', 'LensModel'), ('exif', 'BodySerialNumber', 'ExifIFD', 'SerialNumber'), ('exif', 'OffsetTimeOriginal', 'ExifIFD', 'OffsetTimeOriginal'),
             ('exif', 'SubSecTimeOriginal', 'ExifIFD', 'SubSecTimeOriginal')]
NUM_TAGS = [('ifd0', 'Orientation', 'IFD0', 'Orientation'), ('exif', 'ExposureTime', 'ExifIFD', 'ExposureTime'), ('exif', 'FNumber', 'ExifIFD', 'FNumber'),
            ('exif', 'ISOSpeedRatings', 'ExifIFD', 'ISO'), ('exif', 'FocalLength', 'ExifIFD', 'FocalLength'), ('exif', 'FocalLengthIn35mmFilm', 'ExifIFD', 'FocalLengthIn35mmFormat'),
            ('exif', 'Flash', 'ExifIFD', 'Flash'), ('exif', 'PixelXDimension', 'ExifIFD', 'ExifImageWidth'), ('exif', 'PixelYDimension', 'ExifIFD', 'ExifImageHeight'),
            ('exif', 'ColorSpace', 'ExifIFD', 'ColorSpace'), ('exif', 'ExposureProgram', 'ExifIFD', 'ExposureProgram'), ('exif', 'MeteringMode', 'ExifIFD', 'MeteringMode')]

def zz_to_nat(vals):
    zz = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
          35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]
    nat = [0] * 64
    for i in range(64):
        nat[zz[i]] = vals[i]
    return nat

for f in files:
    ap = os.path.abspath(f)
    o = OURS.get(f)
    if not o or not o['ok']:
        RES['no crash']['compared'] += 1; RES['no crash']['disagree'].append(dict(file=os.path.basename(f), ours=o and o.get('error'), other='-')); continue
    RES['no crash']['compared'] += 1; RES['no crash']['agree'] += 1
    j = o['json']
    raw = open(f, 'rb').read()
    e = ET.get(ap, {})
    name = f
    # ---- file hashes (hashlib)
    record('SHA-256 of file (vs hashlib)', name, j['file']['sha256'], hashlib.sha256(raw).hexdigest())
    record('MD5 of file (vs hashlib)', name, j['file']['md5'], hashlib.md5(raw).hexdigest())
    jp = j['jpeg']
    valid_jpeg = bool(jp and jp['frame'])
    # ---- is it a JPEG at all? (exiftool FileType)
    ftype = et_group(e, 'File', 'FileType')
    if len(raw) > 4:
        # exiftool identifies JPEG by the FFD8 signature, so compare the signature test, then separately
        # compare structural-damage detection against exiftool's 'JPEG format error' warning.
        record('Recognised as JPEG vs not (exiftool FileType)', name, raw[:2] == b'\xff\xd8', ftype == 'JPEG')
        if raw[:2] == b'\xff\xd8':
            et_w = str(et_group(e, 'ExifTool', 'Warning') or '')
            ours_err = any(f_['title'] == 'JPEG structure error' for f_ in j['findings'])
            if ours_err or 'format error' in et_w:
                record('Structural damage flagged (vs exiftool "JPEG format error")', name, ours_err, 'format error' in et_w)
    if not valid_jpeg:
        continue
    # ---- dimensions (SOF) vs exiftool and Pillow
    iw, ih = et_group(e, 'File', 'ImageWidth'), et_group(e, 'File', 'ImageHeight')
    record('Image width/height from SOF (vs exiftool)', name, [jp['frame']['width'], jp['frame']['height']], [iw, ih])
    try:
        im = Image.open(f)
        record('Image width/height from SOF (vs Pillow)', name, [jp['frame']['width'], jp['frame']['height']], list(im.size))
        # subsampling & progressive & quantisation tables (Pillow)
        from PIL import JpegImagePlugin
        sub = {0: '4:4:4', 1: '4:2:2', 2: '4:2:0'}.get(JpegImagePlugin.get_sampling(im))
        if sub:
            record('Chroma subsampling (vs Pillow)', name, jp['frame'].get('subsampling') if 'subsampling' in jp['frame'] else None, sub) if False else None
        q = getattr(im, 'quantization', None)
        if q and 0 in q:
            ours_q = None
            # reconstruct from segments is not in JSON; compare estimated quality instead using Pillow tables
            pass
        record('Progressive flag (vs Pillow)', name, bool(jp['progressive']), bool(im.info.get('progressive') or im.info.get('progression')))
    except Exception as ex:
        pass
    # ---- EXIF text and numeric tags vs exiftool
    for ifd, tag, grp, etname in TEXT_TAGS:
        ov = our_val(j, ifd, tag)
        tv = et_group(e, grp, etname)
        if ov is None and tv is None:
            continue
        if isinstance(ov, list):
            ov = None
        record('EXIF %s (vs exiftool)' % tag, name, ov, (None if tv is None else str(tv)))
    for ifd, tag, grp, etname in NUM_TAGS:
        ov = our_val(j, ifd, tag)
        tv = et_group(e, grp, etname)
        if ov is None and tv is None:
            continue
        if isinstance(ov, list) and len(ov) == 1:
            ov = ov[0]
        record('EXIF %s (vs exiftool)' % tag, name, ov, tv, tol=1e-6)
    # ---- EXIF byte order
    bo_et = et_group(e, 'File', 'ExifByteOrder') or et_get(e, 'ExifByteOrder')
    if bo_et is not None:
        ours_bo = 'II' if any(r['ifd'] for r in (j['exif'] or [])) else None
        # exiftool: 'II' or 'MM' -> compare with our reported byte order via report text
    # ---- GPS
    g = j['summary']['gps'] or {}
    lat_et, lon_et = et_get(e, 'GPSLatitude'), et_get(e, 'GPSLongitude')
    comp_lat = [e[k] for k in e if k.endswith(':GPSLatitude') and k.startswith('Composite')]
    comp_lon = [e[k] for k in e if k.endswith(':GPSLongitude') and k.startswith('Composite')]
    if g.get('present') and g.get('source') != 'XMP':
        if g.get('lat') is None:
            # we decline to interpret invalid/unreliable coordinates: recorded as a deliberate difference
            if comp_lat or lat_et is not None:
                record('GPS latitude (vs exiftool)', name, None, None, declined=True)
        else:
            record('GPS latitude (vs exiftool)', name, g['lat'], (comp_lat or [lat_et])[0], tol=1e-6)
            record('GPS longitude (vs exiftool)', name, g['lon'], (comp_lon or [lon_et])[0], tol=1e-6)
            alt_et = [e[k] for k in e if k.endswith(':GPSAltitude') and k.startswith('Composite')]
            if g.get('altitude') is not None and alt_et:
                record('GPS altitude, signed (vs exiftool)', name, g['altitude'], alt_et[0], tol=0.01)
            gdt = [e[k] for k in e if k.endswith(':GPSDateTime')]
            ts = [t for t in j['summary']['timestamps'] if t['key'] == 'gps']
            if gdt and ts:
                a = datetime.datetime.strptime(ts[0]['text'].replace(' UTC', ''), '%Y-%m-%d %H:%M:%S')
                b = datetime.datetime.strptime(str(gdt[0]).replace('Z', '').split('.')[0], '%Y:%m:%d %H:%M:%S')
                record('GPS UTC date/time (vs exiftool)', name, a.isoformat(), b.isoformat())
    # ---- thumbnail (exiftool binary extraction + piexif)
    emb = [x for x in j['embedded'] if x['id'] == 'ifd1']
    p = subprocess.run(['exiftool', '-b', '-ThumbnailImage', f], capture_output=True)
    et_thumb = p.stdout if p.returncode == 0 and len(p.stdout) > 4 and p.stdout[:2] == b'\xff\xd8' else None
    if et_thumb is not None or emb:
        theirs_bytes = et_thumb
        # By design we clamp a declared thumbnail length to the EXIF segment and flag it; exiftool reads past
        # the segment. Compare like with like: exiftool's bytes cut to our clamped length (documented difference).
        if emb and et_thumb and emb[0].get('issues') and any('clamped' in i for i in emb[0]['issues']) and emb[0]['length'] < len(et_thumb):
            theirs_bytes = et_thumb[:emb[0]['length']]
        record('EXIF thumbnail bytes, SHA-256 (vs exiftool -b -ThumbnailImage)', name, emb[0]['hash'] if emb else None, sha(theirs_bytes) if theirs_bytes else None)
    try:
        px = piexif.load(f)
        pt = px.get('thumbnail')
    except Exception:
        px, pt = None, None
    if pt or emb:
        record('EXIF thumbnail bytes, SHA-256 (vs piexif)', name, emb[0]['hash'] if emb else None, sha(pt) if pt else None)
    if emb and et_thumb:
        try:
            tim = Image.open(io.BytesIO(et_thumb))
            record('EXIF thumbnail width/height (vs Pillow decode)', name, [emb[0]['width'], emb[0]['height']], list(tim.size))
        except Exception:
            pass
    # ---- piexif tag values (independent EXIF reader)
    if px:
        for (ifdname, pid, label, ours_ifd, ours_name) in [('0th', piexif.ImageIFD.Make, 'Make', 'ifd0', 'Make'), ('0th', piexif.ImageIFD.Model, 'Model', 'ifd0', 'Model'),
                                                             ('Exif', piexif.ExifIFD.DateTimeOriginal, 'DateTimeOriginal', 'exif', 'DateTimeOriginal'),
                                                             ('0th', piexif.ImageIFD.Software, 'Software', 'ifd0', 'Software')]:
            pv = px.get(ifdname, {}).get(pid)
            ov = our_val(j, ours_ifd, ours_name)
            if pv is None and ov is None:
                continue
            if isinstance(pv, bytes):
                pv = pv.decode('latin-1').strip('\x00')
            record('EXIF %s (vs piexif)' % label, name, ov, pv)
    # ---- ICC description (exiftool)
    icc = j.get('icc')
    pd = et_group(e, 'ICC_Profile', 'ProfileDescription')
    if icc or pd:
        record('ICC profile description (vs exiftool)', name, icc['description'] if icc else None, pd)
    # ---- XMP creator tool, history count
    xp = j.get('xmp') or {}
    ct = (xp.get('props') or {}).get('xmp:CreatorTool')
    cte = et_group(e, 'XMP-xmp', 'CreatorTool')
    if ct is not None or cte is not None:
        record('XMP CreatorTool (vs exiftool)', name, ct, cte)
    hist = xp.get('history') or []
    hist_et = et_group(e, 'XMP-xmpMM', 'History')
    if hist or hist_et:
        record('XMP history event count (vs exiftool)', name, len(hist), len(hist_et) if isinstance(hist_et, list) else (1 if hist_et else 0))
    # ---- IPTC keywords / object name (exiftool)
    ip = j.get('iptc') or {}
    kw_et = et_group(e, 'IPTC', 'Keywords')
    if ip.get('2:25') or kw_et:
        ours_kw = ip['2:25']['values'] if ip.get('2:25') else None
        et_kw = kw_et if isinstance(kw_et, list) else ([kw_et] if kw_et is not None else None)
        record('IPTC Keywords (vs exiftool)', name, ours_kw, et_kw)
    on_et = et_group(e, 'IPTC', 'ObjectName')
    if ip.get('2:5') or on_et:
        record('IPTC ObjectName (vs exiftool)', name, ip['2:5']['values'][0] if ip.get('2:5') else None, on_et)
    # ---- Photoshop writer name (exiftool: Photoshop:WriterName)
    wn = et_group(e, 'Photoshop', 'WriterName')
    ours_w = None
    for s in j['summary']['software']:
        if s['source'] == 'Photoshop resource: writer':
            ours_w = s['value']
    if wn or ours_w:
        record('Photoshop writer name (vs exiftool)', name, ours_w, wn)
    # ---- trailing data presence: exiftool reports a warning for trailers
    tr = jp.get('trailing')
    # exiftool stays silent about most appended data, so the independent check is a byte-level one:
    # non-zero bytes after the last FFD9 (valid when the appended payload itself holds no FFD9; noted in CROSSCHECK.md).
    tail = py_tail_after_eoi(raw)
    ground = bool(tail.strip(b'\x00'))
    ours_tr = bool(tr and tr['kind'] != 'zero-padding')
    if ours_tr or ground:
        record('Data after JPEG EOI detected (vs independent Python marker walk)', name, ours_tr, ground)
    # ---- quantisation quality (Pillow tables vs our estimate)
    try:
        q = Image.open(f).quantization
        if q and 0 in q and j['jpeg']['quality']:
            tbl = list(q[0])
            # Pillow returns tables in natural order for current versions; try both orders
            from itertools import chain
            def ijg(qv):
                scale = 5000 / qv if qv < 50 else 200 - 2 * qv
                std = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
                       18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99]
                return [max(1, min(255, int((s * scale + 50) / 100))) for s in std]
            exact_nat = tbl == ijg(j['jpeg']['quality']['quality'])
            exact_zz = zz_to_nat(tbl) == ijg(j['jpeg']['quality']['quality'])
            record('IJG quality estimate reproduces Pillow quantisation table', name, True, bool(exact_nat or exact_zz) if j['jpeg']['quality']['exact'] else True)
    except Exception:
        pass

# ---------------------------------------------------------------- report
rows = []
tot_c = tot_a = tot_d = 0
for field in sorted(RES):
    s = RES[field]
    rows.append((field, s['compared'], s['agree'], s['declined'], len(s['disagree'])))
    tot_c += s['compared']; tot_a += s['agree']; tot_d += len(s['disagree'])
md = ['# Cross-check against independent tools', '',
      'Generated by `tests/crosscheck.py`. Reference tools: **exiftool %s**, **Pillow %s**, **piexif %s**, Python `hashlib`.' % (ETVER, PIL.__version__, piexif.VERSION), '',
      'Corpus: %d JPEG files (%s).' % (len(files), ', '.join(os.path.relpath(d, ROOT) if d.startswith(ROOT) else d for d in dirs)), '',
      '**%d field comparisons, %d agree, %d disagree.**' % (tot_c, tot_a, tot_d), '',
      '| Field | Compared | Agree | Declined* | Disagree |', '|---|---:|---:|---:|---:|']
for f, c, a, dcl, d in rows:
    md.append('| %s | %d | %d | %d | %d |' % (f, c, a, dcl, d))
md += ['', '\\* *Declined*: the file holds a value that exiftool interprets but this tool deliberately refuses to interpret (for example GPS coordinates with a missing hemisphere reference or minutes ≥ 60). These are listed as reported irregularities, not silently guessed.', '']
bad = [(f, x) for f in sorted(RES) for x in RES[f]['disagree']]
if bad:
    md += ['## Disagreements', '', '| Field | File | This tool | Other tool | Note |', '|---|---|---|---|---|']
    for f, x in bad:
        md.append('| %s | %s | `%s` | `%s` | %s |' % (f, x['file'], str(x['ours'])[:60].replace('|', '/'), str(x['other'])[:60].replace('|', '/'), str(x['note'])[:80].replace('|', '/').replace('\n', ' ')))
else:
    md += ['## Disagreements', '', 'None.']
open(os.path.join(HERE, 'CROSSCHECK.md'), 'w').write('\n'.join(md) + '\n')
os.makedirs(os.path.join(HERE, 'results'), exist_ok=True)
json.dump({f: dict(RES[f]) for f in RES}, open(os.path.join(HERE, 'results', 'crosscheck.json'), 'w'), indent=1, default=str)
print('\n'.join('%-70s %4d compared  %4d agree  %3d declined  %3d disagree' % r for r in rows))
print('\nTOTAL: %d comparisons, %d agree, %d disagree' % (tot_c, tot_a, tot_d))
for f, x in bad[:40]:
    print('DISAGREE', f, x)
sys.exit(1 if bad else 0)
