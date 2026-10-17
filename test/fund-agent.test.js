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

test('addresses: raw-key taproot, checked against Knots deriveaddresses', async () => {
  const { addressOf, createFaucet, parseFaucet } = await import('../index.js');
  assert.equal(addressOf('txbt4', '22'.repeat(32)), 'tb1pyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q7fyw6k');
  assert.equal(addressOf('tbtc4', '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d9959f2815b16f8179'), 'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3kv4nu5ptvt0s9usdrnxmp');
  assert.match(addressOf('btc', '22'.repeat(32)), /^bc1p/);
  const f = createFaucet({ chain: 'txbt4', privateKey: key });
  assert.equal(f.funded, false);
  assert.equal(f.uri, `txo:txbt4?key=${key}`);
  assert.deepEqual(parseFaucet(`urn:voucher:${f.uri}`), f);
  const v = parseFaucet(`txo:txbt4:${txid}:1?amount=5000&key=${key}`);
  assert.equal(v.funded, true);
  assert.equal(v.address, f.address);
  assert.throws(() => createFaucet({ chain: 'doge' }), /Unknown chain/);
});

test('refreshVoucher fills in the largest confirmed UTXO and rewrites the file', async () => {
  const { createFaucet, refreshVoucher, agentsFrom, loadVoucher } = await import('../index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-agent-'));
  const file = path.join(dir, 'faucet.txt');
  const f = createFaucet({ chain: 'txbt4', privateKey: key });
  fs.writeFileSync(file, f.uri + '\n');
  const calls = [];
  const fetch = async (url) => { calls.push(url); return { ok: true, json: async () => [
    { txid: 'aa'.repeat(32), vout: 0, value: 50000, status: { confirmed: false } },
    { txid: 'bb'.repeat(32), vout: 2, value: 20000, status: { confirmed: true } },
    { txid: 'cc'.repeat(32), vout: 1, value: 30000, status: { confirmed: true } },
  ] }; };
  const r = await refreshVoucher({ uri: f.uri, file }, { fetch });
  assert.equal(calls[0], `https://mempool.guide/testnet4/api/address/${f.address}/utxo`);
  assert.equal(r.voucher.funded, true);
  assert.equal(r.voucher.txid, 'cc'.repeat(32));
  assert.equal(r.voucher.vout, 1);
  assert.equal(r.voucher.amount, 30000);
  assert.equal(loadVoucher(file), `txo:txbt4:${'cc'.repeat(32)}:1?amount=30000&key=${key}`);
  const empty = await refreshVoucher({ uri: f.uri, file: null }, { fetch: async () => ({ ok: true, json: async () => [] }) });
  assert.equal(empty.voucher.funded, false);
  assert.deepEqual(agentsFrom(30000), { full: Math.floor(30000 / (INIT_AMOUNT + MIN_FEE)), partial: true });
  assert.deepEqual(agentsFrom(2 * (INIT_AMOUNT + MIN_FEE) + 500), { full: 2, partial: false });
  fs.rmSync(dir, { recursive: true });
});

test('every chain has an hrp and an api base the broadcast endpoint hangs off', () => {
  for (const [id, c] of Object.entries(CHAINS)) {
    assert.ok(['tb', 'bc'].includes(c.hrp), id);
    assert.equal(c.broadcast, `${c.api}/tx`, id);
  }
});

test('init stores a voucher from a string or from a file path, never the path itself', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-agent-'));
  const faucet = path.join(dir, 'faucet.txt');
  const bin = new URL('../bin/fund-agent.js', import.meta.url).pathname;
  const run = (...a) => execFileSync(process.execPath, [bin, ...a], { encoding: 'utf8', env: { ...process.env, FUND_AGENT_FAUCET: faucet } });
  const uri = `txo:txbt4:${txid}:1?amount=5000&key=${key}`;
  run('init', `urn:voucher:${uri}`);
  assert.equal(fs.readFileSync(faucet, 'utf8').trim(), uri);
  const src = path.join(dir, 'given.txt');
  fs.writeFileSync(src, `txo:tbtc4:${txid}:0?amount=7000&key=${key}\n`);
  run('init', '--force', src);
  assert.equal(fs.readFileSync(faucet, 'utf8').trim(), `txo:tbtc4:${txid}:0?amount=7000&key=${key}`);
  assert.match(run('status', '--dry-run'), /Balance: 7,000 sats/);
  fs.rmSync(dir, { recursive: true });
});

test('broadcast posts the hex to the chain endpoint and returns the txid, or the node error', async () => {
  const { broadcast } = await import('../index.js');
  const calls = [];
  const ok = async (url, init) => { calls.push([url, init.method, init.body]); return { ok: true, status: 200, text: async () => `${txid}\n` }; };
  assert.equal(await broadcast('0200deadbeef', 'txbt4', { fetch: ok }), txid);
  assert.deepEqual(calls[0], ['https://mempool.guide/testnet4/api/tx', 'POST', '0200deadbeef']);
  await assert.rejects(broadcast('00', 'btc', { fetch: async () => ({ ok: false, status: 400, text: async () => 'sendrawtransaction RPC error: bad-txns-inputs-missingorspent' }) }), /400 from https:\/\/mempool.space\/api\/tx.*missingorspent/);
  await assert.rejects(broadcast('00', 'tbtc4', { fetch: async () => ({ ok: true, status: 200, text: async () => '<html>' }) }), /unexpected reply/);
});

test('fund: change becomes the next voucher; with no change the key waits in the file at the same address', async () => {
  const { fund, createFaucet, loadVoucher } = await import('../index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-agent-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const file = path.join(dir, 'faucet.txt');
    const sent = [];
    const fetch = async (url, init) => { sent.push(init.body); return { ok: true, status: 200, text: async () => 'ab'.repeat(32) }; };
    const agent = '22'.repeat(32);
    const big = await fund({ publicKey: agent, voucher: { chain: 'txbt4', txid, vout: 0, privateKey: key, amount: 5000000 }, voucherFile: file, fetch });
    assert.equal(big.newVoucher, `txo:txbt4:${'ab'.repeat(32)}:1?amount=${5000000 - INIT_AMOUNT - MIN_FEE}&key=${key}`);
    assert.equal(loadVoucher(file), big.newVoucher);
    const small = await fund({ publicKey: agent, voucher: { chain: 'txbt4', txid, vout: 0, privateKey: key, amount: 10000 }, voucherFile: file, fetch });
    assert.equal(small.newVoucher, null);
    assert.equal(loadVoucher(file), `txo:txbt4?key=${key}`);
    assert.equal(small.address, createFaucet({ chain: 'txbt4', privateKey: key }).address);
    assert.equal(sent.length, 2);
    assert.equal(JSON.parse(fs.readFileSync('.well-known/txo/txo.json', 'utf8')).length, 2);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true });
  }
});
