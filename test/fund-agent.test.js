import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVoucher, createVoucher, createTxo, planFunding, explorerUrl, chainInfo, CHAINS, INIT_AMOUNT, MIN_FEE, VERSION } from '../index.js';

const key = 'ab'.repeat(32);
const txid = 'cd'.repeat(32);

test('parses a txo: voucher and its urn:voucher: form alike', () => {
  const a = parseVoucher(`txo:tbtc4:${txid}:1?amount=5000000&key=${key}`);
  const b = parseVoucher(`urn:voucher:txo:tbtc4:${txid}:1?key=${key}&amount=5000000`);
  assert.deepEqual(a, { chain: 'tbtc4', txid, vout: 1, privateKey: key, amount: 5000000 });
  assert.deepEqual(b, a);
});

test('rejects vouchers without a key, an amount, or a well-formed path', () => {
  assert.throws(() => parseVoucher(`txo:tbtc4:${txid}:0?amount=1`), /missing key/);
  assert.throws(() => parseVoucher(`txo:tbtc4:${txid}:0?key=${key}`), /missing amount/);
  assert.throws(() => parseVoucher(`txo:tbtc4:${txid}?key=${key}&amount=1`), /expected txo:/);
  assert.throws(() => parseVoucher(`txo:doge:${txid}:0?key=${key}&amount=1`), /unknown chain "doge"/);
  assert.throws(() => parseVoucher(`txo:tbtc4:abc:0?key=${key}&amount=1`), /64 hex/);
  assert.throws(() => parseVoucher('nope'), /must start with txo:/);
});

test('voucher and txo URIs round-trip', () => {
  const v = { chain: 'signet', txid, vout: 1, privateKey: key, amount: 42 };
  assert.deepEqual(parseVoucher(createVoucher(v)), v);
  assert.equal(createTxo({ chain: 'signet', txid, vout: 0, pubkey: key, amount: 42 }), `txo:signet:${txid}:0?amount=42&pubkey=${key}`);
});

test('plan: caps the agent at INIT_AMOUNT, returns change, small vouchers still work', () => {
  const big = planFunding({ chain: 'tbtc4', amount: 5000000 });
  assert.equal(big.userAmount, INIT_AMOUNT);
  assert.equal(big.changeAmount, 5000000 - INIT_AMOUNT - MIN_FEE);
  assert.equal(big.fee, MIN_FEE);
  const small = planFunding({ chain: 'tbtc4', amount: 10000 });
  assert.equal(small.userAmount, 10000 - MIN_FEE);
  assert.equal(small.changeAmount, 0);
  assert.throws(() => planFunding({ chain: 'tbtc4', amount: MIN_FEE }), /too low/);
  assert.throws(() => planFunding({ chain: 'doge', amount: 10000 }), /Unknown chain "doge"/);
});

test('every chain has a name, a broadcast endpoint and an explorer, on the right host', () => {
  for (const [id, c] of Object.entries(CHAINS)) {
    assert.ok(c.name && c.broadcast && c.explorer, id);
    const host = c.sighash === 'unified' ? 'mempool.guide' : 'mempool.space';
    assert.ok(c.broadcast.includes(host) && c.explorer.includes(host), `${id} on ${host}`);
  }
  assert.equal(explorerUrl('tbtc4', txid), `https://mempool.space/testnet4/tx/${txid}`);
  assert.equal(explorerUrl('txbt4', txid), `https://mempool.guide/testnet4/tx/${txid}`);
  assert.equal(chainInfo('xbt').sighash, 'unified');
});

test('version comes from package.json', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('a BLAKE2b-chain voucher is signed with the unified sighash, a Core-chain one with BIP341', async () => {
  const { buildFundingTx } = await import('../index.js');
  const { parseTransaction } = await import('../lib/unified.js');
  const { schnorr } = await import('@noble/curves/secp256k1');
  const priv = '11'.repeat(32);
  const pub = Buffer.from(schnorr.getPublicKey(Buffer.from(priv, 'hex'))).toString('hex');
  const agent = '22'.repeat(32);
  const u = await buildFundingTx({ publicKey: agent, voucher: { chain: 'txbt4', txid, vout: 0, privateKey: priv, amount: 10000 } });
  assert.equal(u.sighash, 'unified');
  assert.equal(u.userAmount, 9000);
  assert.equal(u.changeAmount, 0);
  const tx = parseTransaction(Uint8Array.from(Buffer.from(u.hex, 'hex')));
  assert.equal(tx.inputs[0].witness[0].length, 65);
  assert.equal(tx.inputs[0].witness[0][64], 0x21);
  const b = await buildFundingTx({ publicKey: agent, voucher: { chain: 'tbtc4', txid, vout: 0, privateKey: priv, amount: 10000 } });
  assert.equal(b.sighash, 'bip341');
  assert.equal(parseTransaction(Uint8Array.from(Buffer.from(b.hex, 'hex'))).inputs[0].witness[0].length, 64);
});
