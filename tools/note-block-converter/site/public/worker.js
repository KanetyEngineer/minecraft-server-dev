// ブラウザ内で oto2noteblock.py をそのまま動かす（Pyodide）。ファイルはどこにも送らない。
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
importScripts(PYODIDE + "pyodide.js");

let py = null;
const ready = (async () => {
  post({ type: "status", text: "Python を読み込み中…（初回は 10MB ほど）" });
  py = await loadPyodide({ indexURL: PYODIDE });
  await py.loadPackage("micropip");
  post({ type: "status", text: "mido を入れています…" });
  await py.pyimport("micropip").install("mido");
  const src = await (await fetch("py/oto2noteblock.py", { cache: "no-cache" })).text();
  py.FS.mkdirTree("/app");
  py.FS.writeFile("/app/oto2noteblock.py", src);
  py.runPython("import sys; sys.path.insert(0, '/app'); import oto2noteblock");
  post({ type: "ready" });
})().catch((e) => post({ type: "fatal", text: String(e) }));

function post(m, transfer) { self.postMessage(m, transfer || []); }

function rmrf(dir) {
  const FS = py.FS;
  if (!FS.analyzePath(dir).exists) return;
  for (const f of FS.readdir(dir)) {
    if (f === "." || f === "..") continue;
    const p = dir + "/" + f;
    if (FS.isDir(FS.stat(p).mode)) { rmrf(p); FS.rmdir(p); } else FS.unlink(p);
  }
}

self.onmessage = async (e) => {
  const { id, name, data, args } = e.data;
  await ready;
  if (!py) return;
  const FS = py.FS;
  rmrf("/work");
  FS.mkdirTree("/work/in");
  FS.mkdirTree("/work/out");
  const inPath = "/work/in/" + name;
  FS.writeFile(inPath, new Uint8Array(data));
  const stem = name.replace(/\.[^.]+$/, "");
  const argv = [inPath, "-o", "/work/out/" + stem, ...args];
  py.setStdout({ batched: (s) => post({ type: "log", id, text: s }) });
  py.setStderr({ batched: (s) => post({ type: "log", id, text: s, err: true }) });
  let code = 0;
  try {
    py.globals.set("ARGV", py.toPy(argv));
    code = py.runPython(`
import oto2noteblock as _o
_code = 0
try:
    _o.main(list(ARGV))
except SystemExit as _e:
    if isinstance(_e.code, str):
        print(_e.code)
        _code = 1
    else:
        _code = _e.code or 0
_code
`);
  } catch (err) {
    post({ type: "log", id, text: String(err.message || err), err: true });
    code = 1;
  }
  const files = [];
  const transfer = [];
  for (const f of FS.readdir("/work/out")) {
    if (f === "." || f === "..") continue;
    const bytes = FS.readFile("/work/out/" + f);
    files.push({ name: f, bytes });
    transfer.push(bytes.buffer);
  }
  post({ type: "done", id, code, files }, transfer);
};
