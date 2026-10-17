import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1';
import { unifiedSighash, parseTransaction, SCRIPT_TYPE_TAPROOT } from '../lib/unified.js';
import { buildUnifiedTx, p2trScript, HASH_TYPE } from '../lib/tx.js';

const unhex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const hex = (b) => Buffer.from(b).toString('hex');

test('unified sighash matches all Knots vectors', () => {
  const [header, ...rows] = JSON.parse(readFileSync(new URL('./unified_sighash.json', import.meta.url)));
  assert.equal(header.join(), 'scriptCode,rawTx,inIdx,hashType,scriptType,spentOutputs,sighash');
  for (const [scriptCodeHex, rawTx, inIdx, hashType, scriptType, spent, expected] of rows) {
    const tx = parseTransaction(unhex(rawTx));
    const spentOutputs = spent.map(([value, script]) => ({ value: BigInt(value), script: unhex(script) }));
    const scriptCode = unhex(scriptCodeHex);
    const opts = scriptType === 3 ? { leafScript: scriptCode } : { scriptCode };
    assert.equal(hex(unifiedSighash(tx, inIdx, hashType, scriptType, spentOutputs, opts)), expected);
  }
  assert.equal(rows.length, 166);
});

test('buildUnifiedTx: parses back, signature verifies against the unified message, hash type 0x21', () => {
  const priv = '11'.repeat(32);
  const pub = hex(schnorr.getPublicKey(unhex(priv)));
  const dest = '22'.repeat(32);
  const prev = 'ab'.repeat(32);
  const r = buildUnifiedTx({ privateKey: priv, publicKey: pub, txid: prev, vout: 1, inputAmount: 10000, outputs: [{ pubkey: dest, amount: 5000 }, { pubkey: pub, amount: 4000 }] });
  const tx = parseTransaction(unhex(r.hex));
  assert.equal(tx.inputs.length, 1);
  assert.equal(hex(Uint8Array.from(tx.inputs[0].txid).reverse()), prev);
  assert.equal(tx.inputs[0].vout, 1);
  assert.equal(tx.outputs.length, 2);
  assert.equal(tx.outputs[0].value, 5000n);
  assert.equal(hex(tx.outputs[0].script), hex(p2trScript(dest)));
  const w = tx.inputs[0].witness;
  assert.equal(w.length, 1);
  assert.equal(w[0].length, 65);
  assert.equal(w[0][64], HASH_TYPE);
  const msg = unifiedSighash(tx, 0, HASH_TYPE, SCRIPT_TYPE_TAPROOT, [{ value: 10000n, script: p2trScript(pub) }]);
  assert.ok(schnorr.verify(w[0].slice(0, 64), msg, unhex(pub)));
  assert.match(r.txid, /^[0-9a-f]{64}$/);
});

test('buildUnifiedTx rejects a mismatched key and overspending', () => {
  const priv = '11'.repeat(32);
  const pub = hex(schnorr.getPublicKey(unhex(priv)));
  assert.throws(() => buildUnifiedTx({ privateKey: priv, publicKey: '33'.repeat(32), txid: 'ab'.repeat(32), inputAmount: 10, outputs: [{ pubkey: pub, amount: 5 }] }), /does not match/);
  assert.throws(() => buildUnifiedTx({ privateKey: priv, publicKey: pub, txid: 'ab'.repeat(32), inputAmount: 10, outputs: [{ pubkey: pub, amount: 11 }] }), /exceed/);
});
