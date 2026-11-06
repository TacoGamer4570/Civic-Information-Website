// Node helper: decode a generated state file (same steps as js/redistrict/app.js).
const zlib = require("zlib");
const path = require("path");
global.window = global.window || global;
const RE = require("../js/redistrict/engine.js");

const TYPES = { u8: Uint8Array, u32: Uint32Array, i32: Int32Array, u16: Uint16Array, f32: Float32Array, d32: Int32Array };

function unpack(type, b64) {
  const buf = zlib.inflateSync(Buffer.from(b64, "base64"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const a = new TYPES[type](ab);
  if (type === "d32") for (let i = 1; i < a.length; i++) a[i] += a[i - 1];
  return a;
}

function loadState(st) {
  require(path.join(__dirname, "..", "data", "redistricting", st.toLowerCase() + ".js"));
  const meta = window.REDISTRICT_DATA[st];
  const A = {};
  for (const [name, [type, b64]] of Object.entries(meta.arrays)) A[name] = unpack(type, b64);
  return { meta, A, graph: RE.prepareGraph(meta, A) };
}

module.exports = { loadState, unpack };
