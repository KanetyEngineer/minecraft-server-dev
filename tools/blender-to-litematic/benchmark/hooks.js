require('@loaders.gl/polyfills');
Object.assign(global, { ReadableStream: require('stream/web').ReadableStream, TextEncoder: require('util').TextEncoder, TextDecoder: require('util').TextDecoder });
const fs = require('fs');
require.extensions['.atlas'] = (m, f) => { const s = fs.readFileSync(f, 'utf8'); m.exports = { default: s, __esModule: true }; };
for (const ext of ['.png', '.jpg', '.vs', '.fs', '.css']) require.extensions[ext] = (m, f) => { m.exports = f; m.exports.default = f; };
global.FileReader = class {
  _done(r) { this.result = r; this.readyState = 2; if (this.onload) this.onload({ target: this }); if (this.onloadend) this.onloadend({ target: this }); }
  readAsArrayBuffer(b) { b.arrayBuffer().then((a) => this._done(a)); }
  readAsText(b) { b.text().then((t) => this._done(t)); }
  readAsDataURL(b) { b.arrayBuffer().then((a) => this._done(`data:${b.type || 'application/octet-stream'};base64,` + Buffer.from(a).toString('base64'))); }
  addEventListener(n, f) { this['on' + n] = f; }
};
