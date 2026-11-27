# Quanttum Photo Inspector

Offline JPEG metadata and thumbnail inspector, in vanilla JavaScript with no framework and no runtime dependencies.
Open `index.html` in a browser (works from `file://`). Nothing is uploaded: a Content-Security-Policy blocks all
network access (`connect-src 'none'`), which the end-to-end test verifies (0 requests).

**Core idea.** Cameras embed a small preview (the EXIF thumbnail). If someone crops a photo afterwards and the editor
keeps the old preview, the thumbnail still shows the uncropped original. The tool compares thumbnail and main image
and shows what was cut.

## What it reports
- **Thumbnail vs main image**: consistent / main image cropped (with the matching rectangle) / thumbnail shows only part /
  different picture / weak or uninformative; EXIF orientation and letterbox bars handled; local-retouch difference map.
- **GPS** (coordinates, altitude, GPS timestamp, internal consistency), **device** (make, model, lens, serials),
  **timestamps** (EXIF/XMP/file, offsets, contradictions), **edit-software traces** (EXIF Software, XMP history,
  Photoshop/IPTC/ICC, C2PA presence), **structure** (segment map, quantisation-based quality estimate, trailing data,
  malformed segments, MPF).
- **Printable case report** (A4): hashes, findings, images, segment map, EXIF appendix, limitations, signature block;
  optional masking of GPS/serials/owner. Also JSON export.

## Use
Open `index.html`, drop JPEGs, read the tabs. "Load demo photo" opens a synthetic cropped file (see `samples/README.md`).
CLI: `node tools/inspect-cli.js photo.jpg` (metadata and structure; the pixel comparison needs a browser decoder).

## Tests and measured results
Run `python3 tests/make_fixtures.py` once (generates 113 fixtures, not shipped), then:

| Suite | Command | Result |
|---|---|---|
| Parser tests | `node tests/parser_tests.js` | 41 / 41 |
| Comparison tests | `node tests/compare_tests.js` | 71 / 71 |
| Randomized evaluation | `python3 tests/random_eval.py && node tests/random_eval.js` | 240 cases; see below |
| Fuzz (truncate/flip/inject) | `node tests/fuzz_test.js` | 4,639 inputs, 0 throws, 0 hangs |
| Cross-check vs exiftool 13.64, Pillow 12.3, piexif 1.1.3, hashlib | `python3 tests/crosscheck.py` | 3,834 comparisons, 0 disagreements (`tests/CROSSCHECK.md`) |
| Browser end-to-end (Chrome via Playwright) | `node tests/e2e_test.js` | 16 checks pass: CSP under file://, verdicts, XSS fixture inert, report + PDF, zero network |

Randomized evaluation (synthetic transformations of public-domain images): clean files never flagged as cropped
(0 / 63); crops detected 95 / 95; no unrelated or replaced thumbnail judged consistent or cropped; replaced thumbnails
flagged as mismatch in 24 / 30 (the rest reported as "weak", never as consistent).

**Caveat on the cross-check.** Fixtures are mostly produced by our own builder (plus Pillow and piexif writers), so
agreement shows parsing correctness on those inputs, not on every camera in the world. Where we differ by design
(we clamp a thumbnail length that runs past its EXIF segment and flag it; exiftool reads past it) the script compares
like with like and the difference is documented. Real-camera files, maker notes and other formats are untested.

## Limits (read before relying on any result)
1. Findings are **leads, not verdicts**. No flags does not mean unedited; flags can have innocent causes.
2. Not validated forensic software. No independent validation study, no accreditation, no error-rate study on real
   camera files; use it to direct examination and corroborate with accepted tools.
3. Thumbnail evidence exists only if the file has one. Many editors and platforms regenerate or strip it; a regenerated
   thumbnail matching the main image says nothing.
4. Crops below about 4 % of the frame, and retouching below about 1 %, are not detectable. Retouching over about 20 %
   of the frame degrades the match to "weak" or "mismatch".
5. Arbitrary-angle rotation is not modelled (2 of 13 small-rotation test cases were reported as cropped).
6. Same-scene burst or tripod frames can look consistent with each other.
7. Metadata is trivially forged or stripped. Maker notes are not decoded. C2PA is detected, not validated.
8. No pixel forensics (no ELA, PRNU, double-compression analysis, or splice detection).
9. Timestamps carry no authority: camera clocks are set by users and time zones are often missing.

## Layout
`index.html`, `css/`, `js/` (sha, jpeg, exif, xmp, irb, compare, analyze, decode, report, samples, app),
`tools/` (CLI, dump, sample generator), `tests/`, `samples/`, `docs/`.

## Licence
MIT, see `LICENSE`. Demo image: scikit-image "chelsea" (CC0).
