/*
 * Quanttum Photo Inspector — browser pixel decoding (vanilla JS)
 *
 * Uses the browser's own JPEG decoder via <img> + <canvas>. Nothing is uploaded:
 * the bytes are wrapped in a local blob: URL. Browser-only (not used in Node).
 */
(function (g) {
  'use strict';
  var QPI = g.QPI = g.QPI || {};

  function loadImage(u8) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([u8], { type: 'image/jpeg' }));
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('The browser could not decode this JPEG.')); };
      img.src = url;
    });
  }

  /**
   * Decode JPEG bytes to RGBA, optionally downscaled so the long side is <= maxSide.
   * Returns { rgba, w, h, naturalW, naturalH } (naturalW/H = size after the browser applied EXIF orientation).
   */
  function decode(u8, maxSide) {
    return loadImage(u8).then(function (r) {
      var img = r.img, nw = img.naturalWidth, nh = img.naturalHeight;
      if (!nw || !nh) { URL.revokeObjectURL(r.url); throw new Error('Decoded image has no size.'); }
      var s = maxSide && Math.max(nw, nh) > maxSide ? maxSide / Math.max(nw, nh) : 1;
      var w = Math.max(1, Math.round(nw * s)), h = Math.max(1, Math.round(nh * s));
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      var data = ctx.getImageData(0, 0, w, h).data;
      URL.revokeObjectURL(r.url);
      return { rgba: data, w: w, h: h, naturalW: nw, naturalH: nh };
    });
  }

  function toCanvas(rgba, w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    return c;
  }

  /** True when the browser rotated the image according to its EXIF Orientation (compared with the SOF size). */
  function orientationApplied(sofW, sofH, naturalW, naturalH) {
    return sofW !== sofH && naturalW === sofH && naturalH === sofW;
  }

  QPI.decode = { decode: decode, toCanvas: toCanvas, orientationApplied: orientationApplied };
  if (typeof module !== 'undefined' && module.exports) module.exports = QPI.decode;
})(typeof window !== 'undefined' ? window : globalThis);
