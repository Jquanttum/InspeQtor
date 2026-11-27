'use strict';
// Loads every Quanttum Photo Inspector module into Node (they attach to globalThis.QPI).
const path = require('path');
const dir = path.join(__dirname, '..', 'js');
['sha', 'jpeg', 'exif', 'xmp', 'irb', 'compare', 'analyze', 'report'].forEach(m => require(path.join(dir, m + '.js')));
module.exports = globalThis.QPI;
