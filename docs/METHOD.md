# Thumbnail comparison method

1. Decode thumbnail and main image to luma, reduced to at most 256 px on the long side.
2. Strip black letterbox bars; try the eight EXIF orientation transforms and keep the best.
3. Whole-frame score: 20 %-trimmed (robust) Pearson correlation, which tolerates local retouching. "Same picture" needs >= 0.90.
4. Crop search: aspect-locked rectangle search using plain correlation via a summed-area table. A sub-rectangle claim needs
   >= 0.88, a gain of >= 0.03 over whole-frame, and a margin >= 0.04 over the runner-up. Plain (not robust) correlation is
   used because its null maximum (~0.68) is far below the threshold, whereas the robust null maximum (~0.89) is not.
5. Residual difference map when frames align.
Thresholds live in `CFG` in `js/compare.js`; behaviour at the edges is documented in README "Limits".
