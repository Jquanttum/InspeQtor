#!/usr/bin/env python3
"""
Quanttum Photo Inspector - fixture factory.

Builds every test JPEG under tests/fixtures/ together with tests/fixtures/manifest.json (ground truth).
Base pictures are the CC0 / public-domain sample photographs bundled with scikit-image
(coffee, chelsea, astronaut, rocket). Two independent writers are used so the parser is not only
tested against its author's assumptions: a hand-written EXIF/XMP/IRB builder (this file, both byte
orders, deliberate corruptions) and piexif + Pillow.

Usage: python3 tests/make_fixtures.py
"""
import io, json, os, struct, sys
import numpy as np
from PIL import Image, ImageEnhance, ImageOps
import piexif
import skimage.data as skd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')
os.makedirs(OUT, exist_ok=True)
MANIFEST = {}

# ------------------------------------------------------------------ base pictures
def base_images():
    def up(arr, size):
        return Image.fromarray(arr).convert('RGB').resize(size, Image.LANCZOS)
    return {
        'coffee': up(skd.coffee(), (1200, 800)),
        'chelsea': up(skd.chelsea(), (1200, 800)),
        'astronaut': up(skd.astronaut(), (900, 900)),
        'rocket': up(skd.rocket(), (800, 1200)),
    }

def jpeg(im, q=88, sub=None, **kw):
    b = io.BytesIO()
    args = dict(quality=q)
    if sub is not None:
        args['subsampling'] = sub
    args.update(kw)
    im.convert('RGB').save(b, 'JPEG', **args)
    return b.getvalue()

def roundtrip(im, q=80):
    return Image.open(io.BytesIO(jpeg(im, q))).convert('RGB')

def thumb_of(im, long_side=160, q=72):
    w, h = im.size
    s = long_side / max(w, h)
    t = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    return jpeg(t, q)

# ------------------------------------------------------------------ hand-written TIFF/EXIF builder
def enc(le, typ, val):
    e = '<' if le else '>'
    if typ == 'ascii':
        b = val.encode('utf-8') + b'\0'; return 2, len(b), b
    if typ == 'byte':
        return 1, len(val), bytes(val)
    if typ == 'undef':
        return 7, len(val), bytes(val)
    if typ == 'short':
        return 3, len(val), b''.join(struct.pack(e + 'H', v) for v in val)
    if typ == 'long':
        return 4, len(val), b''.join(struct.pack(e + 'I', v) for v in val)
    if typ == 'sshort':
        return 8, len(val), b''.join(struct.pack(e + 'h', v) for v in val)
    if typ == 'slong':
        return 9, len(val), b''.join(struct.pack(e + 'i', v) for v in val)
    if typ == 'rational':
        return 5, len(val), b''.join(struct.pack(e + 'II', n, d) for n, d in val)
    if typ == 'srational':
        return 10, len(val), b''.join(struct.pack(e + 'ii', n, d) for n, d in val)
    raise ValueError(typ)

def ifd_size(entries, le):
    n = len(entries); data = 0
    for _, typ, val in entries:
        raw = enc(le, typ, val)[2]
        if len(raw) > 4:
            data += len(raw) + (len(raw) & 1)
    return 2 + 12 * n + 4 + data

def pack_ifd(entries, base, le, next_ptr=0, huge_count=None):
    e = '<' if le else '>'
    entries = sorted(entries, key=lambda t: t[0])
    n = len(entries)
    out = struct.pack(e + 'H', n)
    data_off = base + 2 + 12 * n + 4
    data = b''
    for tag, typ, val in entries:
        t, cnt, raw = enc(le, typ, val)
        if huge_count and tag == huge_count:
            cnt = 0x7FFFFFF0
        if len(raw) <= 4:
            field = raw.ljust(4, b'\0')
        else:
            field = struct.pack(e + 'I', data_off + len(data))
            data += raw + (b'\0' if len(raw) & 1 else b'')
        out += struct.pack(e + 'HHI', tag, t, cnt) + field
    out += struct.pack(e + 'I', next_ptr)
    return out + data

def build_tiff(ifd0, exif=None, gps=None, interop=None, thumb=None, le=True, ifd1_loop=False,
               bad_value_offset_tag=None, makernote=None, thumb_declare_len=None, ifd1_extra=None):
    """ifd0/exif/gps/interop: lists of (tag, type, value). Returns TIFF bytes."""
    e = '<' if le else '>'
    ifd0 = list(ifd0); exif = list(exif or []); gps = list(gps or []); interop = list(interop or [])
    if makernote is not None:
        exif.append((0x927C, 'undef', makernote))
    if interop:
        exif.append((0xA005, 'long', [0]))
    if exif:
        ifd0.append((0x8769, 'long', [0]))
    if gps:
        ifd0.append((0x8825, 'long', [0]))
    th_entries = []
    if thumb is not None:
        th_entries = [(0x103, 'short', [6]), (0x201, 'long', [0]), (0x202, 'long', [len(thumb)])]
        if ifd1_extra:
            th_entries += ifd1_extra
    # layout
    o_ifd0 = 8
    s_ifd0 = ifd_size(ifd0, le)
    o_exif = o_ifd0 + s_ifd0
    s_exif = ifd_size(exif, le) if exif else 0
    o_interop = o_exif + s_exif
    s_interop = ifd_size(interop, le) if interop else 0
    o_gps = o_interop + s_interop
    s_gps = ifd_size(gps, le) if gps else 0
    o_ifd1 = o_gps + s_gps
    s_ifd1 = ifd_size(th_entries, le) if thumb is not None else 0
    o_thumb = o_ifd1 + s_ifd1

    def fix(entries, ptrs):
        out = []
        for t, ty, v in entries:
            if t in ptrs:
                v = [ptrs[t]]
            out.append((t, ty, v))
        return out
    ifd0 = fix(ifd0, {0x8769: o_exif, 0x8825: o_gps})
    exif = fix(exif, {0xA005: o_interop})
    if bad_value_offset_tag is not None:
        pass
    buf = b'II*\0' if le else b'MM\0*'
    buf += struct.pack(e + 'I', o_ifd0)
    next1 = o_ifd1 if thumb is not None else 0
    if ifd1_loop:
        next1 = o_ifd0
    buf += pack_ifd(ifd0, o_ifd0, le, next1)
    if exif:
        buf += pack_ifd(exif, o_exif, le)
    if interop:
        buf += pack_ifd(interop, o_interop, le)
    if gps:
        buf += pack_ifd(gps, o_gps, le)
    if thumb is not None:
        th = [(t, ty, ([o_thumb] if t == 0x201 else ([thumb_declare_len] if (t == 0x202 and thumb_declare_len is not None) else v))) for t, ty, v in th_entries]
        buf += pack_ifd(th, o_ifd1, le, 0)
        buf += thumb
    return buf

def app1_exif(tiff):
    body = b'Exif\0\0' + tiff
    assert len(body) + 2 <= 65535, 'EXIF too large'
    return b'\xff\xe1' + struct.pack('>H', len(body) + 2) + body

def app1_xmp(xml):
    body = b'http://ns.adobe.com/xap/1.0/\0' + xml.encode('utf-8')
    assert len(body) + 2 <= 65535
    return b'\xff\xe1' + struct.pack('>H', len(body) + 2) + body

def app13_irb(resources):
    body = b'Photoshop 3.0\0'
    for rid, data in resources:
        body += b'8BIM' + struct.pack('>H', rid) + b'\0\0' + struct.pack('>I', len(data)) + data + (b'\0' if len(data) & 1 else b'')
    return b'\xff\xed' + struct.pack('>H', len(body) + 2) + body

def com(text):
    b = text.encode('latin-1')
    return b'\xff\xfe' + struct.pack('>H', len(b) + 2) + b

def insert_after_header(jpg, segs):
    """Insert segments after SOI and an optional JFIF APP0."""
    assert jpg[:2] == b'\xff\xd8'
    pos = 2
    if jpg[2:4] == b'\xff\xe0':
        pos = 4 + struct.unpack('>H', jpg[4:6])[0]
    return jpg[:pos] + b''.join(segs) + jpg[pos:]

def strip_app0(jpg):
    if jpg[2:4] == b'\xff\xe0':
        n = struct.unpack('>H', jpg[4:6])[0]
        return jpg[:2] + jpg[4 + n:]
    return jpg

def rat(x, d=1000):
    return (int(round(x * d)), d)

def dms_rat(deg):
    deg = abs(deg); d = int(deg); m = int((deg - d) * 60); s = (deg - d - m / 60) * 3600
    return [(d, 1), (m, 1), (int(round(s * 10000)), 10000)]

def gps_entries(lat, lon, alt=None, alt_below=False, utc=None, datum='WGS-84', method=None, status=None, dop=None):
    g = [(0, 'byte', [2, 3, 0, 0]),
         (1, 'ascii', 'N' if lat >= 0 else 'S'), (2, 'rational', dms_rat(lat)),
         (3, 'ascii', 'E' if lon >= 0 else 'W'), (4, 'rational', dms_rat(lon))]
    if alt is not None:
        g += [(5, 'byte', [1 if alt_below else 0]), (6, 'rational', [rat(abs(alt), 100)])]
    if utc:
        (Y, M, D), (h, m, s) = utc
        g += [(7, 'rational', [(h, 1), (m, 1), (s, 1)]), (29, 'ascii', '%04d:%02d:%02d' % (Y, M, D))]
    if datum:
        g.append((18, 'ascii', datum))
    if method:
        g.append((27, 'undef', b'ASCII\0\0\0' + method.encode()))
    if status:
        g.append((9, 'ascii', status))
    if dop is not None:
        g.append((11, 'rational', [rat(dop, 100)]))
    return g

def write(name, data, expect=None, **info):
    path = os.path.join(OUT, name + '.jpg')
    with open(path, 'wb') as f:
        f.write(data)
    MANIFEST[name] = dict(info, expect=expect or {})
    return path

def xmp_packet(props_attrs='', body=''):
    return ('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" '
            'xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#" xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#" '
            'xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' + props_attrs + '>' + body + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')

# ------------------------------------------------------------------ standard camera-ish metadata
def camera_ifds(w, h, **over):
    d = dict(offset='+00:00', make='Canon', model='Canon EOS 80D', software='Ver.1.0.3', dt='2024:05:01 12:30:45', dto='2024:05:01 12:30:45',
             dtd='2024:05:01 12:30:45', orient=1, px=w, py=h)
    d.update(over)
    ifd0 = [(0x10F, 'ascii', d['make']), (0x110, 'ascii', d['model']), (0x112, 'short', [d['orient']]), (0x11A, 'rational', [(72, 1)]),
            (0x11B, 'rational', [(72, 1)]), (0x128, 'short', [2]), (0x131, 'ascii', d['software']), (0x132, 'ascii', d['dt']), (0x213, 'short', [1])]
    exif = [(0x829A, 'rational', [(1, 250)]), (0x829D, 'rational', [(56, 10)]), (0x8822, 'short', [3]), (0x8827, 'short', [400]),
            (0x9000, 'undef', b'0231'), (0x9003, 'ascii', d['dto']), (0x9004, 'ascii', d['dtd']), (0x9290, 'ascii', '45'), (0x9291, 'ascii', '45'),
            (0x9207, 'short', [5]), (0x9209, 'short', [16]), (0x920A, 'rational', [(85, 1)]),
            (0xA001, 'short', [1]), (0xA002, 'long', [d['px']]), (0xA003, 'long', [d['py']]), (0xA405, 'short', [136]),
            (0xA431, 'ascii', 'SN123456789'), (0xA434, 'ascii', 'EF85mm f/1.8 USM'), (0xA433, 'ascii', 'Canon')]
    if d['offset']:
        exif.append((0x9011, 'ascii', d['offset']))
    return ifd0, exif

def make_camera_jpeg(main_im, thumb_bytes, le=True, gps=None, ifd0_over=None, exif_over=None, extra_ifd0=None, extra_exif=None, segs=(), q=88, makernote=None, self_loop=False, **cam):
    w, h = main_im.size
    ifd0, exif = camera_ifds(w, h, **cam)
    if extra_ifd0: ifd0 = ifd0 + list(extra_ifd0)
    if extra_exif: exif = exif + list(extra_exif)
    tiff = build_tiff(ifd0, exif, gps, thumb=thumb_bytes, le=le, makernote=makernote, ifd1_loop=self_loop)
    jpg = jpeg(main_im, q)
    return insert_after_header(jpg, [app1_exif(tiff)] + list(segs))

# ------------------------------------------------------------------ thumbnail scenarios
def crop_frac(im, fr):
    w, h = im.size
    return im.crop((round(fr[0] * w), round(fr[1] * h), round(fr[2] * w), round(fr[3] * h)))

def thumbnail_fixtures(bases):
    for bname, base in bases.items():
        W, H = base.size
        other = bases['chelsea' if bname != 'chelsea' else 'coffee']
        other = other.resize((W, H), Image.LANCZOS)
        T = thumb_of(base)
        gen = lambda name, main, thumb, expect, **kw: write('t_%s_%s' % (bname, name), make_camera_jpeg(main, thumb, **kw.pop('cam', {})), dict(expect, base=bname), kind='thumb', **kw)
        gen('clean', base, T, dict(verdict='consistent'))
        for nm, fr in [('crop_c60', (0.2, 0.2, 0.8, 0.8)), ('crop_tl', (0.0, 0.0, 0.55, 0.6)), ('crop_br', (0.4, 0.35, 1.0, 1.0)), ('crop_8', (0.08, 0.08, 0.92, 0.92)), ('crop_wide', (0.0, 0.25, 1.0, 0.75))]:
            gen(nm, crop_frac(base, fr), T, dict(verdict='main-cropped', rect=[fr[0], fr[1], fr[2] - fr[0], fr[3] - fr[1]]))
        gen('crop_2', crop_frac(base, (0.02, 0.02, 0.98, 0.98)), T, dict(verdict='consistent', limit='crop below 4% is not detectable'))
        gen('bright', ImageEnhance.Contrast(ImageEnhance.Brightness(base).enhance(1.25)).enhance(1.1), T, dict(verdict='consistent'))
        gen('resized', base.resize((W // 2, H // 2), Image.LANCZOS), T, dict(verdict='consistent'))
        gen('replaced', other, T, dict(verdict='mismatch'))
        # thumbnail regenerated after cropping: nothing to find
        c = crop_frac(base, (0.2, 0.2, 0.8, 0.8))
        gen('crop_thumb_regen', c, thumb_of(c), dict(verdict='consistent', note='editor regenerated the thumbnail'))
        # letterboxed / squashed thumbnails
        tt = Image.open(io.BytesIO(T)).convert('RGB')
        cw, ch = (120, 160) if H > W else (160, 120)
        fit = tt.copy(); fit.thumbnail((cw, ch), Image.LANCZOS)
        pad = Image.new('RGB', (cw, ch), (0, 0, 0)); pad.paste(fit, ((cw - fit.width) // 2, (ch - fit.height) // 2))
        gen('letterbox', base, jpeg(pad, 75), dict(verdict='consistent'))
        sq = base.resize((160, 120) if W >= H else (120, 160), Image.LANCZOS)
        if W != H:
            gen('squash', base, jpeg(sq, 75), dict(verdict='consistent', note='distorted-aspect'))
        # retouching
        r = base.copy()
        pw, ph = int(W * 0.30), int(H * 0.30)
        px, py = int(W * 0.55), int(H * 0.45)
        r.paste(Image.new('RGB', (pw, ph), (235, 235, 235)), (px, py))
        gen('retouch_big', r, T, dict(verdict='consistent', diff=True, patch=[px / W, py / H, pw / W, ph / H]))
        r2 = base.copy(); r2.paste(Image.new('RGB', (int(W * 0.06), int(H * 0.06)), (235, 235, 235)), (int(W * 0.55), int(H * 0.45)))
        gen('retouch_small', r2, T, dict(verdict='consistent', limit='retouching below ~1% is not detectable'))
        # thumbnail is a true crop of the main image (aspect preserved)
        fr = (0.1, 0.1, 0.9, 0.9)
        gen('thumb_partial', base, thumb_of(crop_frac(base, fr)), dict(verdict='thumb-partial'))
        if W != H:
            # main stored rotated: raster landscape, Orientation=6 (display is portrait); thumb has same raster
            m = base if W > H else base.transpose(Image.ROTATE_90)
            gen('orient6_same_raster', m, thumb_of(m), dict(verdict='consistent', orientation=6), cam=dict(orient=6))
            gen('orient6_crop', crop_frac(m, (0.1, 0.0, 0.7, 1.0)), thumb_of(m), dict(verdict='main-cropped', orientation=6), cam=dict(orient=6))

# ------------------------------------------------------------------ metadata fixtures
def metadata_fixtures(bases):
    base = bases['coffee'].resize((900, 600), Image.LANCZOS)
    W, H = base.size
    T = thumb_of(base)
    # --- complete camera files, both byte orders
    gps = gps_entries(51.501, -0.1419, alt=35.2, utc=((2024, 5, 1), (12, 30, 41)), method='GPS', dop=0.9)
    write('m_full_le', make_camera_jpeg(base, T, le=True, gps=gps, extra_ifd0=[(0x10E, 'ascii', 'Test scene'), (0x13B, 'ascii', 'J. Examiner'), (0x8298, 'ascii', '(c) Quanttum')],
                                          extra_exif=[(0x9286, 'undef', b'ASCII\0\0\0hello comment')]), kind='meta', expect=dict(endian='II', lat=51.501, lon=-0.1419))
    write('m_full_be', make_camera_jpeg(base, T, le=False, gps=gps, extra_ifd0=[(0x10E, 'ascii', 'Test scene')]), kind='meta', expect=dict(endian='MM', lat=51.501, lon=-0.1419))
    write('m_gps_sw', make_camera_jpeg(base, T, gps=gps_entries(-33.8568, -151.2153, alt=12, alt_below=True, utc=((2024, 5, 1), (2, 30, 41)))), kind='meta', expect=dict(lat=-33.8568, lon=-151.2153))
    write('m_gps_null', make_camera_jpeg(base, T, gps=[(1, 'ascii', 'N'), (2, 'rational', [(0, 1), (0, 1), (0, 1)]), (3, 'ascii', 'E'), (4, 'rational', [(0, 1), (0, 1), (0, 1)])]), kind='meta', expect=dict(gps_issue='Null Island'))
    write('m_gps_badrefs', make_camera_jpeg(base, T, gps=[(2, 'rational', [(10, 1), (75, 1), (5, 1)]), (4, 'rational', [(20, 1), (10, 1), (5, 1)])]), kind='meta', expect=dict(gps_issue='ref'))
    write('m_gps_zero_den', make_camera_jpeg(base, T, gps=[(1, 'ascii', 'N'), (2, 'rational', [(10, 0), (5, 1), (5, 1)]), (3, 'ascii', 'E'), (4, 'rational', [(20, 1), (10, 1), (5, 1)])]), kind='meta', expect=dict())
    write('m_gps_manual', make_camera_jpeg(base, T, gps=gps_entries(48.8584, 2.2945, method='MANUAL', status='V')), kind='meta', expect=dict(gps_issue='MANUAL'))
    # --- time checks
    write('m_time_gps_ok', make_camera_jpeg(base, T, gps=gps_entries(48.85, 2.29, utc=((2024, 5, 1), (10, 30, 45))), offset='+02:00'), kind='meta', expect=dict(time='agrees'))
    write('m_time_gps_implied', make_camera_jpeg(base, T, gps=gps_entries(48.85, 2.29, utc=((2024, 5, 1), (10, 30, 45))), offset=None), kind='meta', expect=dict(time='implied +02:00'))
    write('m_time_gps_bad', make_camera_jpeg(base, T, gps=gps_entries(48.85, 2.29, utc=((2024, 5, 1), (3, 12, 0))), offset='+00:00'), kind='meta', expect=dict(time='gps mismatch'))
    write('m_time_resaved', make_camera_jpeg(base, T, dt='2024:05:04 09:00:00', dto='2024:05:01 12:30:45'), kind='meta', expect=dict(time='re-saved'))
    write('m_time_invalid', make_camera_jpeg(base, T, dto='0000:00:00 00:00:00', dtd='2999:01:01 00:00:00', dt='2024:13:45 99:00:00'), kind='meta', expect=dict(time='invalid'))
    # --- edit software
    xmp = xmp_packet('xmp:CreatorTool="Adobe Photoshop 25.0 (Windows)" xmp:CreateDate="2024-05-01T12:30:45+00:00" xmp:ModifyDate="2024-05-09T18:00:00+00:00" xmp:MetadataDate="2024-05-09T18:00:00+00:00" '
                     'xmpMM:DocumentID="xmp.did:BBB" xmpMM:OriginalDocumentID="xmp.did:AAA" tiff:Make="Canon" crs:HasCrop="True" crs:CropLeft="0.1" crs:CropTop="0.05" crs:CropRight="0.9" crs:CropBottom="0.95" crs:CropAngle="0" '
                     'Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia" exif:DateTimeOriginal="2024-05-03T08:00:00"',
                     '<xmpMM:DerivedFrom stRef:instanceID="xmp.iid:AAA" stRef:documentID="xmp.did:AAA"/>'
                     '<xmpMM:History><rdf:Seq><rdf:li stEvt:action="created" stEvt:when="2024-05-01T12:30:45+00:00" stEvt:softwareAgent="Canon EOS 80D"/>'
                     '<rdf:li stEvt:action="saved" stEvt:when="2024-05-09T18:00:00+00:00" stEvt:softwareAgent="Adobe Photoshop 25.0 (Windows)" stEvt:changed="/"/></rdf:Seq></xmpMM:History>'
                     '<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>')
    write('m_xmp_history', make_camera_jpeg(base, T, segs=[app1_xmp(xmp)], software='Adobe Photoshop 25.0 (Windows)'), kind='meta', expect=dict(editor=True, xmp_ai=True))
    iptc = b''.join(b'\x1c\x02' + bytes([ds]) + struct.pack('>H', len(v)) + v for ds, v in [(5, b'Harbour at dawn'), (25, b'sea'), (25, b'harbour'), (65, b'Adobe Photoshop'), (70, b'25.0'), (55, b'20240501'), (116, b'(c) Test')])
    ver = struct.pack('>I', 1) + b'\x01' + struct.pack('>I', 21) + 'Adobe Photoshop 25.0'.encode('utf-16-be') + struct.pack('>I', 21) + 'Adobe Photoshop 25.0'.encode('utf-16-be') + struct.pack('>I', 1)
    write('m_irb', make_camera_jpeg(base, T, segs=[app13_irb([(0x0404, iptc), (0x0421, ver), (0x0406, struct.pack('>H', 8) + b'\0\0\0\0')])]), kind='meta', expect=dict(irb_writer='Adobe Photoshop 25.0'))
    write('m_comment_gd', insert_after_header(jpeg(base, 90), [com('CREATOR: gd-jpeg v1.0 (using IJG JPEG v62), quality = 90\n')]), kind='meta', expect=dict(library=True))
    write('m_xp_tags', make_camera_jpeg(base, T, extra_ifd0=[(0x9C9D, 'byte', list('Win Author'.encode('utf-16-le') + b'\0\0')), (0x9C9C, 'byte', list('Win comment'.encode('utf-16-le') + b'\0\0'))]), kind='meta', expect=dict(xp=True))
    # --- device spoof indicators
    write('m_makernote_mismatch', make_camera_jpeg(base, T, makernote=b'Apple iOS\0\0\x01MM' + bytes(60), make='Canon', model='Canon EOS 80D'), kind='meta', expect=dict(makernote=True))
    write('m_brand_mismatch', make_camera_jpeg(base, T, make='Canon', model='NIKON D5000'), kind='meta', expect=dict(brand=True))
    write('m_dims_crop', make_camera_jpeg(crop_frac(base, (0, 0, 0.6, 0.8)), T, px=W, py=H), kind='meta', expect=dict(dims='different shape'))
    write('m_dims_resize', make_camera_jpeg(base.resize((450, 300)), T, px=W, py=H), kind='meta', expect=dict(dims='same shape'))
    # --- trailing data
    plain = make_camera_jpeg(base, T)
    write('m_trail_zip', plain + b'PK\x03\x04' + os.urandom(300), kind='meta', expect=dict(trailing='zip'))
    write('m_trail_text', plain + b'secret note: meet at the pier at 9pm. ' * 5, kind='meta', expect=dict(trailing='text'))
    write('m_trail_zero', plain + bytes(64), kind='meta', expect=dict(trailing='zero-padding'))
    write('m_trail_jpeg', plain + jpeg(bases['chelsea'].resize((200, 150)), 80), kind='meta', expect=dict(trailing='jpeg'))
    write('m_trail_mp4', plain + b'\0\0\0\x18ftypmp42\0\0\0\0mp42isom' + os.urandom(100), kind='meta', expect=dict(trailing='mp4'))
    # --- hostile strings (must never execute or break layout)
    xss = '<img src=x onerror="window.__xss=1">"\'<script>window.__xss=2</script>'
    xmp_x = xmp_packet('xmp:CreatorTool="&lt;img src=x onerror=window.__xss=3&gt;"', '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">&lt;b&gt;bold&lt;/b&gt;' + '&amp;' * 3 + '</rdf:li></rdf:Alt></dc:title>')
    write('m_xss', make_camera_jpeg(base, T, make=xss, model=xss, software=xss, segs=[app1_xmp(xmp_x), com(xss)], extra_ifd0=[(0x10E, 'ascii', xss), (0x13B, 'ascii', xss)]), kind='meta', expect=dict(xss=True))
    # --- no metadata / no thumbnail
    write('m_no_exif', jpeg(base, 85), kind='meta', expect=dict(noexif=True))
    write('m_no_thumb', make_camera_jpeg(base, None), kind='meta', expect=dict(nothumb=True))
    write('m_progressive', jpeg(base, 80, progressive=True), kind='meta', expect=dict(progressive=True))
    write('m_q50_444', jpeg(base, 50, sub=0), kind='meta', expect=dict(quality=50, sub='4:4:4'))
    write('m_q95_420', jpeg(base, 95, sub=2), kind='meta', expect=dict(quality=95, sub='4:2:0'))
    # --- structural damage
    ok = make_camera_jpeg(base, T)
    write('c_truncated', ok[: len(ok) // 2], kind='corrupt', expect=dict())
    write('c_truncated_in_exif', ok[:900], kind='corrupt', expect=dict())
    ifd0, exif = camera_ifds(W, H)
    loop = build_tiff(ifd0, exif, None, thumb=None, ifd1_loop=True)
    write('c_ifd_loop', insert_after_header(jpeg(base, 80), [app1_exif(loop)]), kind='corrupt', expect=dict(warning='loop'))
    huge = build_tiff(ifd0 + [(0x10E, 'ascii', 'x' * 20)], exif, None, thumb=T)
    huge = bytearray(huge)
    write('c_huge_offset', insert_after_header(jpeg(base, 80), [app1_exif(bytes(huge).replace(b'xxxxxxxxxxxxxxxxxxxx', b'x' * 20))]), kind='corrupt', expect=dict())
    bad_th = build_tiff(ifd0, exif, None, thumb=T, thumb_declare_len=60000)
    write('c_thumb_badlen', insert_after_header(jpeg(base, 80), [app1_exif(bad_th)]), kind='corrupt', expect=dict(warning='thumb'))
    segs = jpeg(base, 80)
    write('c_bad_marker_len', segs[:2] + b'\xff\xe1\x00\x01' + segs[2:], kind='corrupt', expect=dict())
    write('c_not_jpeg_png', b'\x89PNG\r\n\x1a\n' + os.urandom(200), kind='corrupt', expect=dict(notjpeg=True))
    write('c_empty', b'', kind='corrupt', expect=dict())
    write('c_soi_only', b'\xff\xd8', kind='corrupt', expect=dict())
    cnt = bytearray(build_tiff(ifd0, exif, None, thumb=None))
    tiff_bad = build_tiff(ifd0, exif, None, thumb=None)
    write('c_huge_count', insert_after_header(jpeg(base, 80), [app1_exif(pack_huge_count(ifd0, exif))]), kind='corrupt', expect=dict())

def pack_huge_count(ifd0, exif):
    # IFD0 with one tag claiming an enormous value count
    e = '<'
    n = len(ifd0)
    entries = sorted(ifd0, key=lambda t: t[0])
    body = struct.pack(e + 'H', n + 1)
    data_off = 8 + 2 + 12 * (n + 1) + 4
    data = b''
    all_e = entries + [(0xC000, 'rational', [(1, 1)])]
    for tag, typ, val in sorted(all_e, key=lambda t: t[0]):
        t, cnt, raw = enc(True, typ, val)
        if tag == 0xC000:
            cnt = 0x7FFFFFF0
            field = struct.pack(e + 'I', data_off)
        elif len(raw) <= 4:
            field = raw.ljust(4, b'\0')
        else:
            field = struct.pack(e + 'I', data_off + len(data)); data += raw + (b'\0' if len(raw) & 1 else b'')
        body += struct.pack(e + 'HHI', tag, t, cnt) + field
    body += struct.pack(e + 'I', 0)
    return b'II*\0' + struct.pack(e + 'I', 8) + body + data

# ------------------------------------------------------------------ independent writers: piexif + Pillow
def independent_fixtures(bases):
    base = bases['chelsea'].resize((900, 600), Image.LANCZOS)
    th = thumb_of(base)
    def ratp(n, d=1):
        return (n, d)
    ex = {'0th': {piexif.ImageIFD.Make: b'FUJIFILM', piexif.ImageIFD.Model: b'X-T4', piexif.ImageIFD.Software: b'Digital Camera X-T4 Ver1.20',
                  piexif.ImageIFD.DateTime: b'2023:11:11 08:15:30', piexif.ImageIFD.Orientation: 1, piexif.ImageIFD.Artist: b'P. Writer'},
          'Exif': {piexif.ExifIFD.DateTimeOriginal: b'2023:11:11 08:15:30', piexif.ExifIFD.DateTimeDigitized: b'2023:11:11 08:15:30', piexif.ExifIFD.ExposureTime: (1, 500),
                   piexif.ExifIFD.FNumber: (28, 10), piexif.ExifIFD.ISOSpeedRatings: 160, piexif.ExifIFD.FocalLength: (23, 1), piexif.ExifIFD.PixelXDimension: 900, piexif.ExifIFD.PixelYDimension: 600,
                   piexif.ExifIFD.LensModel: b'XF23mmF2 R WR', piexif.ExifIFD.BodySerialNumber: b'ABC1234'},
          'GPS': {piexif.GPSIFD.GPSLatitudeRef: b'S', piexif.GPSIFD.GPSLatitude: ((12, 1), (30, 1), (4523, 100)), piexif.GPSIFD.GPSLongitudeRef: b'E', piexif.GPSIFD.GPSLongitude: ((130, 1), (50, 1), (1000, 100)),
                  piexif.GPSIFD.GPSAltitudeRef: 0, piexif.GPSIFD.GPSAltitude: (5120, 100), piexif.GPSIFD.GPSDateStamp: b'2023:11:10', piexif.GPSIFD.GPSTimeStamp: ((22, 1), (15, 1), (30, 1))},
          '1st': {piexif.ImageIFD.Compression: 6}, 'thumbnail': th}
    out = io.BytesIO(); base.save(out, 'JPEG', quality=88, exif=piexif.dump(ex))
    write('i_piexif_fuji', out.getvalue(), kind='indep', expect=dict(make='FUJIFILM'))
    # Pillow-native EXIF (no thumbnail)
    exif = Image.Exif(); exif[0x010F] = 'Google'; exif[0x0110] = 'Pixel 8'; exif[0x0131] = 'HDR+ 1.0.123'
    sub = exif.get_ifd(0x8769); sub[0x9003] = '2024:02:02 10:00:00'
    out = io.BytesIO(); base.save(out, 'JPEG', quality=90, exif=exif)
    write('i_pillow_pixel', out.getvalue(), kind='indep', expect=dict(make='Google'))
    # Pillow saved with ICC profile
    from PIL import ImageCms
    prof = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
    out = io.BytesIO(); base.save(out, 'JPEG', quality=90, icc_profile=prof)
    write('i_pillow_icc', out.getvalue(), kind='indep', expect=dict(icc=True))

def export_pgm(bases):
    """Pillow-decoded greyscale grids of every thumbnail fixture (independent decode path for the Node comparison tests)."""
    pairs = {}
    for name, meta in MANIFEST.items():
        if meta.get('kind') != 'thumb':
            continue
        path = os.path.join(OUT, name + '.jpg')
        im = Image.open(path); im.load()
        try:
            ex = piexif.load(path)
        except Exception:
            ex = None
        th_bytes = ex['thumbnail'] if ex else None
        if not th_bytes:
            continue
        main = ImageOps.exif_transpose(im).convert('L')
        th = Image.open(io.BytesIO(th_bytes)).convert('L')
        for tag, img in (('main', main), ('thumb', th)):
            a = np.asarray(img)
            with open(os.path.join(OUT, '%s.%s.pgm' % (name, tag)), 'wb') as f:
                f.write(b'P5\n%d %d\n255\n' % (a.shape[1], a.shape[0]) + a.tobytes())
        pairs[name] = True
    return pairs

if __name__ == '__main__':
    bases = base_images()
    thumbnail_fixtures(bases)
    metadata_fixtures(bases)
    independent_fixtures(bases)
    export_pgm(bases)
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(MANIFEST, f, indent=1, sort_keys=True)
    n = len([k for k in MANIFEST])
    size = sum(os.path.getsize(os.path.join(OUT, k + '.jpg')) for k in MANIFEST)
    print('wrote %d fixtures (%.1f MB) to %s' % (n, size / 1e6, OUT))
