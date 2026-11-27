# Changelog

## 0.1.0 — 2026-11-27
First release.
- JPEG structure, EXIF/TIFF (both endians), XMP, Photoshop IRB/IPTC, ICC, MPF, C2PA-presence parsing; SHA-256 and MD5.
- EXIF thumbnail vs main image comparison (crop / partial thumbnail / orientation / letterbox / local retouch map).
- Findings for GPS, device, timestamps, edit-software traces, structure and trailing data.
- Printable A4 case report with hashes, findings, images, segment map, limitations, signature block.
- Test suites: 41 parser tests, 71 comparison tests, randomized evaluation (240 cases), 4,639-input fuzz run,
  browser end-to-end test, cross-check against exiftool / Pillow / piexif / hashlib (3,834 comparisons, 0 disagreements).
