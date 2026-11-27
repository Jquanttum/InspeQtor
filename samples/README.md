# Demo sample

`demo_cropped_keeps_thumbnail.jpg` is a **synthetic test file**, not a real case photograph.
Image content: the scikit-image "chelsea" cat photograph (CC0 / public-domain dedication).
The main image is a central 60 % crop; the EXIF thumbnail still holds the uncropped original frame, which is
exactly what the inspector is built to expose. Camera, timestamps and software strings are synthetic.
Regenerate with `python3 tests/make_fixtures.py && python3 tools/make_samples.py`.
