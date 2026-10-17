// Taproot key-path spend signed with the unified opt-in sighash (hash type
// 0x21), for the BLAKE2b chains (txbt4, xbt). Mirrors btctx's buildTx shape:
// one P2TR input, any number of P2TR outputs keyed by x-only pubkey, no tweak.
// The sighash itself is lib/unified.js, vendored from bitcoin-blake/blaketest
// and checked against the 166 Knots vectors in test/unified_sighash.json.

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { unifiedSighash, SIGHASH_ALL, SIGHASH_UNIFIED, SCRIPT_TYPE_TAPROOT, compactSize, u32le, i64le, concat } from './unified.js';

export const HASH_TYPE = SIGHASH_ALL | SIGHASH_UNIFIED; // 0x21

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const isHex64 = (s) => typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);

/** OP_1 <32-byte x-only key>: a raw taproot output, no script tree, no tweak. */
export function p2trScript(pubkey) {
  if (!isHex64(pubkey)) throw new Error('Invalid pubkey: expected 64-char hex string');
  return concat(Uint8Array.of(0x51, 0x20), unhex(pubkey));
}

function serialize(tx, witnesses) {
  const parts = [u32le(tx.version)];
  if (witnesses) parts.push(Uint8Array.of(0, 1));
  parts.push(compactSize(tx.inputs.length));
  for (const i of tx.inputs) parts.push(i.txid, u32le(i.vout), Uint8Array.of(0), u32le(i.sequence));
  parts.push(compactSize(tx.outputs.length));
  for (const o of tx.outputs) parts.push(i64le(o.value), compactSize(o.script.length), o.script);
  if (witnesses) {
    for (const w of witnesses) {
      parts.push(compactSize(w.length));
      for (const item of w) parts.push(compactSize(item.length), item);
    }
  }
  parts.push(u32le(tx.locktime));
  return concat(...parts);
}

/**
 * Build and sign a unified-sighash taproot transaction.
 * @param {{privateKey: string, publicKey: string, txid: string, vout?: number, inputAmount: number, outputs: {pubkey: string, amount: number}[]}} options
 * @returns {{hex: string, txid: string, hashType: number}}
 */
export function buildUnifiedTx({ privateKey, publicKey, txid, vout = 0, inputAmount, outputs }) {
  if (!isHex64(privateKey)) throw new Error('Invalid privateKey: expected 64-char hex string');
  if (!isHex64(publicKey)) throw new Error('Invalid publicKey: expected 64-char hex string');
  if (!isHex64(txid)) throw new Error('Invalid txid: expected 64-char hex string');
  if (!Number.isInteger(inputAmount) || inputAmount <= 0) throw new Error('Invalid inputAmount: expected positive integer');
  if (!Array.isArray(outputs) || outputs.length === 0) throw new Error('Invalid outputs: expected non-empty array');
  const derived = hex(schnorr.getPublicKey(unhex(privateKey)));
  if (derived !== publicKey.toLowerCase()) throw new Error('publicKey does not match privateKey');
  const total = outputs.reduce((a, o) => {
    if (!Number.isInteger(o.amount) || o.amount <= 0) throw new Error('Invalid output amount: expected positive integer');
    return a + o.amount;
  }, 0);
  if (total > inputAmount) throw new Error(`Outputs (${total}) exceed input (${inputAmount})`);

  const tx = {
    version: 2,
    locktime: 0,
    inputs: [{ txid: unhex(txid).reverse(), vout, sequence: 0xfffffffd }],
    outputs: outputs.map((o) => ({ value: BigInt(o.amount), script: p2trScript(o.pubkey) })),
  };
  const spent = [{ value: BigInt(inputAmount), script: p2trScript(publicKey) }];
  const msg = unifiedSighash(tx, 0, HASH_TYPE, SCRIPT_TYPE_TAPROOT, spent);
  const sig = schnorr.sign(msg, unhex(privateKey));
  if (!schnorr.verify(sig, msg, unhex(publicKey))) throw new Error('signature did not verify');
  const witnesses = [[concat(sig, Uint8Array.of(HASH_TYPE))]];

  const stripped = serialize(tx, null);
  const id = hex(sha256(sha256(stripped)).reverse());
  return { hex: hex(serialize(tx, witnesses)), txid: id, hashType: HASH_TYPE };
}
