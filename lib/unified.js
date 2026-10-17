// Unified opt-in signature hash (Bitcoin Knots PR #357), as shipped in
// v29.4.1.knots20260508. Spec: doc/unified-sighash.md in that tag, copied
// here as unified-sighash.md. Vectors: unified_sighash.json (166 rows).
//
// One message for every script type. A signature opts in by setting
// SIGHASH_UNIFIED (0x20) in its hash type byte, so SIGHASH_ALL becomes 0x21.
// A node that does not implement the fork computes the legacy message for the
// same byte and the signature fails there, which is what makes an opted-in
// transaction unreplayable onto the SHA256d chain.

import { sha256 } from '@noble/hashes/sha256';

export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_UNIFIED = 0x20;
export const SIGHASH_ANYONECANPAY = 0x80;

export const SCRIPT_TYPE_BASE = 0;      // bare or P2SH
export const SCRIPT_TYPE_WITNESS_V0 = 1;
export const SCRIPT_TYPE_TAPROOT = 2;   // key path
export const SCRIPT_TYPE_TAPSCRIPT = 3;

const TAPLEAF_VERSION = 0xc0;

// ---- serialization helpers -------------------------------------------------

export function compactSize(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  if (n <= 0xffffffff) return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  throw new Error('compactSize: value too large');
}

export function u32le(n) {
  return Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

export function i64le(v) {
  const out = new Uint8Array(8);
  let t = BigInt.asUintN(64, BigInt(v));
  for (let i = 0; i < 8; i++) { out[i] = Number(t & 0xffn); t >>= 8n; }
  return out;
}

export function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function taggedHash(tag, msg) {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concat(t, t, msg));
}

function serializeOutput(out) {
  return concat(i64le(out.value), compactSize(out.script.length), out.script);
}

function serializeOutpoint(inp) {
  return concat(inp.txid, u32le(inp.vout));
}

// ---- transaction parsing ---------------------------------------------------

// Parses a raw transaction (legacy or segwit serialization) into
// { version, inputs: [{ txid, vout, scriptSig, sequence, witness }],
//   outputs: [{ value, script }], locktime, segwit }.
// txid is kept in wire (little-endian) byte order.
export function parseTransaction(bytes) {
  let o = 0;
  const readCS = () => {
    const first = bytes[o++];
    if (first < 0xfd) return first;
    let size = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    let v = 0n;
    for (let i = 0; i < size; i++) v |= BigInt(bytes[o + i]) << BigInt(8 * i);
    o += size;
    return Number(v);
  };
  const take = (n) => { const s = bytes.subarray(o, o + n); if (s.length !== n) throw new Error('truncated'); o += n; return s; };
  const readU32 = () => { const b = take(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
  const readI64 = () => { const b = take(8); let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return BigInt.asIntN(64, v); };

  const version = readU32();
  let segwit = false;
  if (bytes[o] === 0x00 && bytes[o + 1] === 0x01) { segwit = true; o += 2; }
  const nIn = readCS();
  const inputs = [];
  for (let i = 0; i < nIn; i++) {
    const txid = take(32);
    const vout = readU32();
    const scriptSig = take(readCS());
    const sequence = readU32();
    inputs.push({ txid, vout, scriptSig, sequence, witness: [] });
  }
  const nOut = readCS();
  const outputs = [];
  for (let i = 0; i < nOut; i++) {
    const value = readI64();
    const script = take(readCS());
    outputs.push({ value, script });
  }
  if (segwit) {
    for (let i = 0; i < nIn; i++) {
      const n = readCS();
      for (let j = 0; j < n; j++) inputs[i].witness.push(take(readCS()));
    }
  }
  const locktime = readU32();
  if (o !== bytes.length) throw new Error('trailing bytes after transaction');
  return { version, inputs, outputs, locktime, segwit };
}

// ---- the message -----------------------------------------------------------

export function tapleafHash(script, version = TAPLEAF_VERSION) {
  return taggedHash('TapLeaf', concat(Uint8Array.of(version), compactSize(script.length), script));
}

// tx: parsed transaction (see parseTransaction), or any object of that shape.
// spentOutputs: [{ value, script }] one per input, in input order.
// opts.scriptCode: required for script types 0 and 1 (Uint8Array, no length prefix).
// opts.annex: Uint8Array or undefined, taproot only.
// opts.tapleafHash / opts.leafScript: script type 3 only (one of them).
// opts.codeseparatorPos: script type 3 only, default 0xffffffff.
export function unifiedSighash(tx, inIdx, hashType, scriptType, spentOutputs, opts = {}) {
  if (!(hashType & SIGHASH_UNIFIED)) throw new Error('hash type does not opt in to SIGHASH_UNIFIED');
  if (inIdx >= tx.inputs.length) throw new Error('input index out of range');
  if (spentOutputs.length !== tx.inputs.length) throw new Error('need one spent output per input');
  const taproot = scriptType === SCRIPT_TYPE_TAPROOT || scriptType === SCRIPT_TYPE_TAPSCRIPT;
  const outputType = hashType & 0x1f;
  if (taproot) {
    if (hashType & ~(0x1f | SIGHASH_ANYONECANPAY | SIGHASH_UNIFIED)) throw new Error('undefined hash type for taproot');
    if (outputType !== SIGHASH_ALL && outputType !== SIGHASH_NONE && outputType !== SIGHASH_SINGLE) throw new Error('undefined hash type for taproot');
  }
  const anyonecanpay = !!(hashType & SIGHASH_ANYONECANPAY);

  const parts = [];
  parts.push(Uint8Array.of(0));                 // epoch
  parts.push(Uint8Array.of(hashType & 0xff));   // hash type, one byte
  parts.push(u32le(tx.version));
  parts.push(u32le(tx.locktime), Uint8Array.of(0)); // locktime, five bytes

  if (!anyonecanpay) {
    parts.push(sha256(concat(...tx.inputs.map(serializeOutpoint))));
    parts.push(sha256(concat(...spentOutputs.map(s => i64le(s.value)))));
    parts.push(sha256(concat(...spentOutputs.map(s => concat(compactSize(s.script.length), s.script)))));
    parts.push(sha256(concat(...tx.inputs.map(i => u32le(i.sequence)))));
  }
  if (outputType !== SIGHASH_NONE && outputType !== SIGHASH_SINGLE) {
    parts.push(sha256(concat(...tx.outputs.map(serializeOutput))));
  }

  parts.push(Uint8Array.of(scriptType));

  if (anyonecanpay) {
    parts.push(serializeOutpoint(tx.inputs[inIdx]));
    parts.push(serializeOutput(spentOutputs[inIdx]));
    parts.push(u32le(tx.inputs[inIdx].sequence));
  } else {
    parts.push(u32le(inIdx));
  }

  if (!taproot) {
    if (!opts.scriptCode) throw new Error('scriptCode required for script types 0 and 1');
    parts.push(compactSize(opts.scriptCode.length), opts.scriptCode);
  } else {
    if (opts.annex) {
      parts.push(Uint8Array.of(1));
      parts.push(sha256(concat(compactSize(opts.annex.length), opts.annex)));
    } else {
      parts.push(Uint8Array.of(0));
    }
  }

  if (outputType === SIGHASH_SINGLE) {
    if (inIdx >= tx.outputs.length) throw new Error('SIGHASH_SINGLE with no matching output');
    parts.push(sha256(serializeOutput(tx.outputs[inIdx])));
  }

  if (scriptType === SCRIPT_TYPE_TAPSCRIPT) {
    const leaf = opts.tapleafHash || (opts.leafScript && tapleafHash(opts.leafScript));
    if (!leaf) throw new Error('tapleaf hash required for tapscript');
    parts.push(leaf);
    parts.push(Uint8Array.of(0)); // key version
    parts.push(u32le(opts.codeseparatorPos ?? 0xffffffff));
  }

  return taggedHash('UnifiedSighash', concat(...parts));
}
