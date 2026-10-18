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

test('balanceOf lists a key\'s coins, confirmed first, with totals', async () => {
  const { balanceOf, addressOf, getPubkey } = await import('../index.js');
  const pub = getPubkey(key);
  const rows = [
    { txid: 'aa'.repeat(32), vout: 0, value: 10000, status: { confirmed: false } },
    { txid: 'bb'.repeat(32), vout: 1, value: 4000, status: { confirmed: true } },
  ];
  const seen = [];
  const fetch = async (url) => { seen.push(url); return { ok: true, json: async () => rows }; };
  const b = await balanceOf('txbt4', pub, { fetch });
  assert.equal(b.address, addressOf('txbt4', pub));
  assert.match(seen[0], new RegExp(`/address/${b.address}/utxo$`));
  assert.deepEqual(b.utxos.map((u) => u.vout), [1, 0]);
  assert.equal(b.confirmed, 4000);
  assert.equal(b.pending, 10000);
  assert.equal(b.total, 14000);
});

test('parseTxo reads the URI git mark keeps in gitmark.txo', async () => {
  const { parseTxo } = await import('../index.js');
  const t = parseTxo(`txo:txbt4:${txid}:0?amount=9700&commit=de04775b6ade67b91caf15013ba73dad5f1b4b67`);
  assert.deepEqual(t, { chain: 'txbt4', txid, vout: 0, amount: 9700, commit: 'de04775b6ade67b91caf15013ba73dad5f1b4b67' });
  assert.deepEqual(parseTxo(`txo:btc:${txid}:3`), { chain: 'btc', txid, vout: 3, amount: null, commit: null });
  assert.throws(() => parseTxo('txo:txbt4:abc:0'), /Invalid txo/);
});

test('lookupOutput reports where the trail coin sits and whether it is spent', async () => {
  const { lookupOutput } = await import('../index.js');
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    if (url.endsWith('/outspend/0')) return { ok: true, json: async () => ({ spent: false }) };
    return { ok: true, json: async () => ({ status: { confirmed: false }, vout: [{ value: 9700, scriptpubkey_address: 'tb1ptrail' }] }) };
  };
  const o = await lookupOutput('txbt4', { txid, vout: 0 }, { fetch });
  assert.deepEqual(o, { address: 'tb1ptrail', amount: 9700, confirmed: false, spent: false });
  assert.ok(seen.some((u) => u === `https://mempool.guide/testnet4/api/tx/${txid}`));
  assert.ok(seen.some((u) => u === `https://mempool.guide/testnet4/api/tx/${txid}/outspend/0`));
  const spent = async (url) => url.endsWith('/outspend/0') ? { ok: true, json: async () => ({ spent: true }) } : { ok: true, json: async () => ({ status: { confirmed: true }, vout: [{ value: 9700, scriptpubkey_address: 'tb1ptrail' }] }) };
  assert.equal((await lookupOutput('txbt4', { txid, vout: 0 }, { fetch: spent })).spent, true);
});

test('balance refuses without an agent key in git config', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-agent-'));
  const bin = new URL('../bin/fund-agent.js', import.meta.url).pathname;
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync(process.execPath, [bin, 'balance'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, 'none') } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No agent key in git config/);
  fs.rmSync(dir, { recursive: true });
});

test('resolveKey funds the key already in git config; --force replaces it', async () => {
  const { resolveKey, getPubkey } = await import('../index.js');
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-agent-'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    execFileSync('git', ['init', '-q']);
    execFileSync('git', ['config', '--local', 'nostr.privkey', key]);
    const same = resolveKey();
    assert.equal(same.created, false);
    assert.equal(same.publicKey, getPubkey(key));
    const legacy = resolveKey({ existing: true });
    assert.equal(legacy.publicKey, getPubkey(key));
    const fresh = resolveKey({ force: true });
    assert.equal(fresh.created, true);
    assert.notEqual(fresh.publicKey, getPubkey(key));
    assert.equal(execFileSync('git', ['config', '--local', 'nostr.privkey'], { encoding: 'utf8' }).trim(), fresh.privateKey);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true });
  }
});

test('planConsolidation: confirmed coins only, at least two, unified chains, worth the fee', async () => {
  const { planConsolidation, consolidationFee } = await import('../index.js');
  const a = { txid: 'aa'.repeat(32), vout: 0, value: 8800, confirmed: true };
  const b = { txid: 'bb'.repeat(32), vout: 1, value: 857000, confirmed: true };
  const p = planConsolidation('txbt4', [a, b]);
  assert.deepEqual(p.inputs.map((u) => u.vout), [1, 0]);           // largest first
  assert.equal(p.total, 865800);
  assert.equal(p.fee, consolidationFee(2));
  assert.equal(p.fee, MIN_FEE + 100);
  assert.equal(p.amount, 865800 - MIN_FEE - 100);
  const withPending = planConsolidation('txbt4', [a, { ...b, confirmed: false }]);
  assert.equal(withPending.inputs.length, 2);                      // unconfirmed coins are merged too
  assert.equal(withPending.pending, 1);
  assert.throws(() => planConsolidation('txbt4', [b]), /nothing to merge/);
  assert.throws(() => planConsolidation('txbt4', []), /No coins/);
  assert.throws(() => planConsolidation('tbtc4', [a, b]), /not supported yet/);
  assert.throws(() => planConsolidation('txbt4', [{ ...a, value: 5000 }, { ...b, value: 5000 }]), /not worth the fee/);
});

test('buildConsolidationTx: every input signed for the unified message at the voucher key, one output back to it', async () => {
  const { buildConsolidationTx, getPubkey } = await import('../index.js');
  const { unifiedSighash, parseTransaction, SCRIPT_TYPE_TAPROOT } = await import('../lib/unified.js');
  const { p2trScript, HASH_TYPE } = await import('../lib/tx.js');
  const { schnorr } = await import('@noble/curves/secp256k1');
  const unhex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
  const hex = (b) => Buffer.from(b).toString('hex');
  const pub = getPubkey(key);
  const utxos = [
    { txid: 'aa'.repeat(32), vout: 0, value: 8800, confirmed: true },
    { txid: 'bb'.repeat(32), vout: 1, value: 857000, confirmed: true },
    { txid: 'cc'.repeat(32), vout: 3, value: 9400, confirmed: true },
  ];
  const r = await buildConsolidationTx({ voucher: { chain: 'txbt4', privateKey: key }, utxos });
  const tx = parseTransaction(unhex(r.hex));
  assert.equal(tx.inputs.length, 3);
  assert.equal(tx.outputs.length, 1);
  assert.equal(hex(tx.outputs[0].script), hex(p2trScript(pub)));
  assert.equal(tx.outputs[0].value, BigInt(r.plan.amount));
  const spent = r.plan.inputs.map((u) => ({ value: BigInt(u.value), script: p2trScript(pub) }));
  for (let i = 0; i < 3; i++) {
    assert.equal(hex(Uint8Array.from(tx.inputs[i].txid).reverse()), r.plan.inputs[i].txid);
    const w = tx.inputs[i].witness[0];
    assert.equal(w.length, 65);
    assert.equal(w[64], HASH_TYPE);
    assert.ok(schnorr.verify(w.slice(0, 64), unifiedSighash(tx, i, HASH_TYPE, SCRIPT_TYPE_TAPROOT, spent), unhex(pub)), `input ${i}`);
  }
});

test('consolidate: looks the address up, dry run posts nothing, a real run posts once and the merged coin becomes the voucher', async () => {
  const { consolidate, createFaucet, loadVoucher, parseFaucet } = await import('../index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-agent-'));
  try {
    const file = path.join(dir, 'faucet.txt');
    const voucher = parseFaucet(createFaucet({ chain: 'txbt4', privateKey: key }).uri);
    fs.writeFileSync(file, voucher.uri + '\n');
    const rows = [
      { txid: 'aa'.repeat(32), vout: 0, value: 8800, status: { confirmed: true } },
      { txid: 'bb'.repeat(32), vout: 1, value: 857000, status: { confirmed: true } },
    ];
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      if (url.endsWith(`/address/${voucher.address}/utxo`)) return { ok: true, json: async () => rows };
      if (init.method === 'POST') return { ok: true, status: 200, text: async () => 'ee'.repeat(32) };
      return { ok: false, status: 404, text: async () => 'not stubbed' };
    };
    const dry = await consolidate({ voucher, voucherFile: file, dryRun: true, fetch });
    assert.equal(dry.txid, null);
    assert.match(dry.hex, /^0200/);
    assert.equal(calls.filter((c) => c.startsWith('POST')).length, 0);
    assert.equal(loadVoucher(file), voucher.uri);                       // untouched
    const real = await consolidate({ voucher, voucherFile: file, fetch });
    assert.equal(real.txid, 'ee'.repeat(32));
    assert.equal(calls.filter((c) => c.startsWith('POST')).length, 1);
    assert.equal(real.newVoucher, `txo:txbt4:${'ee'.repeat(32)}:0?amount=${865800 - MIN_FEE - 100}&key=${key}`);
    assert.equal(loadVoucher(file), real.newVoucher);
    rows[0].status.confirmed = false;
    assert.equal((await consolidate({ voucher, voucherFile: file, dryRun: true, fetch })).plan.pending, 1);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('bootstrap key is sha256("fund-agent bootstrap"), public on purpose, refused on mainnet chains', async () => {
  const { BOOTSTRAP_KEY, bootstrapFaucet, addressOf, getPubkey } = await import('../index.js');
  const { createHash } = await import('node:crypto');
  assert.equal(BOOTSTRAP_KEY, createHash('sha256').update('fund-agent bootstrap').digest('hex'));
  const f = bootstrapFaucet('txbt4');
  assert.equal(f.privateKey, BOOTSTRAP_KEY);
  assert.equal(f.address, addressOf('txbt4', getPubkey(BOOTSTRAP_KEY)));
  assert.equal(f.funded, false);
  assert.throws(() => bootstrapFaucet('btc'), /No bootstrap on btc/);
  assert.throws(() => bootstrapFaucet('xbt'), /No bootstrap on xbt/);
});

test('planBootstrap takes one confirmed coin at random, and says why when there is none', async () => {
  const { planBootstrap, BOOTSTRAP_COIN } = await import('../index.js');
  const coins = [0, 1, 2].map((i) => ({ txid: `${i}${i}`.repeat(32), vout: i, value: BOOTSTRAP_COIN, confirmed: true }));
  assert.equal(planBootstrap(coins, { random: () => 0 }).vout, 0);
  assert.equal(planBootstrap(coins, { random: () => 0.5 }).vout, 1);
  assert.equal(planBootstrap(coins, { random: () => 0.99 }).vout, 2);
  assert.equal(planBootstrap([...coins, { txid: 'ee'.repeat(32), vout: 9, value: 500, confirmed: true }], { random: () => 0.99 }).vout, 2); // dust skipped
  assert.throws(() => planBootstrap([{ ...coins[0], confirmed: false }]), /1 unconfirmed coin/);
  assert.throws(() => planBootstrap([]), /empty/);
});

test('bootstrap: one coin whole into a fresh key, signed by the public key, file written; dry run writes nothing', async () => {
  const { bootstrap, BOOTSTRAP_COIN, BOOTSTRAP_KEY, bootstrapFaucet, loadVoucher, parseFaucet, getPubkey } = await import('../index.js');
  const { unifiedSighash, parseTransaction, SCRIPT_TYPE_TAPROOT } = await import('../lib/unified.js');
  const { p2trScript, HASH_TYPE } = await import('../lib/tx.js');
  const { schnorr } = await import('@noble/curves/secp256k1');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const unhex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
  const hex = (b) => Buffer.from(b).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-agent-'));
  try {
    const file = path.join(dir, 'faucet.txt');
    const from = bootstrapFaucet('txbt4');
    const rows = [{ txid: 'aa'.repeat(32), vout: 2, value: BOOTSTRAP_COIN, status: { confirmed: true } }];
    const calls = [];
    const fetch = async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      if (url.endsWith(`/address/${from.address}/utxo`)) return { ok: true, json: async () => rows };
      if (init.method === 'POST') return { ok: true, status: 200, text: async () => 'ee'.repeat(32) };
      return { ok: false, status: 404, text: async () => 'not stubbed' };
    };
    const dry = await bootstrap({ chain: 'txbt4', voucherFile: file, dryRun: true, fetch });
    assert.equal(dry.txid, null);
    assert.equal(fs.existsSync(file), false);
    assert.equal(calls.filter((c) => c.startsWith('POST')).length, 0);
    const r = await bootstrap({ chain: 'txbt4', voucherFile: file, fetch });
    assert.equal(r.txid, 'ee'.repeat(32));
    assert.equal(r.amount, BOOTSTRAP_COIN - MIN_FEE);
    assert.equal(calls.filter((c) => c.startsWith('POST')).length, 1);
    const v = parseFaucet(loadVoucher(file));
    assert.notEqual(v.privateKey, BOOTSTRAP_KEY);                   // a key of your own
    assert.equal(v.amount, BOOTSTRAP_COIN - MIN_FEE);
    assert.equal(v.txid, 'ee'.repeat(32));
    assert.equal(v.vout, 0);
    const tx = parseTransaction(unhex(r.hex));
    assert.equal(tx.inputs.length, 1);
    assert.equal(hex(Uint8Array.from(tx.inputs[0].txid).reverse()), 'aa'.repeat(32));
    assert.equal(tx.inputs[0].vout, 2);
    assert.equal(tx.outputs.length, 1);                              // whole coin, no change
    assert.equal(hex(tx.outputs[0].script), hex(p2trScript(getPubkey(v.privateKey))));
    const w = tx.inputs[0].witness[0];
    assert.equal(w[64], HASH_TYPE);
    const msg = unifiedSighash(tx, 0, HASH_TYPE, SCRIPT_TYPE_TAPROOT, [{ value: BigInt(BOOTSTRAP_COIN), script: p2trScript(from.publicKey) }]);
    assert.ok(schnorr.verify(w.slice(0, 64), msg, unhex(from.publicKey)));
    rows[0].status.confirmed = false;
    await assert.rejects(bootstrap({ chain: 'txbt4', fetch }), /unconfirmed/);
    await assert.rejects(bootstrap({ chain: 'btc', fetch }), /No bootstrap/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('bootstrap can take the coin into a key given to it, the waiting key already in the file', async () => {
  const { bootstrap, BOOTSTRAP_COIN, bootstrapFaucet, canAdoptForBootstrap, createFaucet, parseFaucet, getPubkey } = await import('../index.js');
  const { parseTransaction } = await import('../lib/unified.js');
  const { p2trScript } = await import('../lib/tx.js');
  const from = bootstrapFaucet('txbt4');
  const rows = [{ txid: 'aa'.repeat(32), vout: 0, value: BOOTSTRAP_COIN, status: { confirmed: true } }];
  const fetch = async (url, init = {}) => url.endsWith(`/address/${from.address}/utxo`) ? { ok: true, json: async () => rows } : { ok: true, status: 200, text: async () => 'ee'.repeat(32) };
  const r = await bootstrap({ chain: 'txbt4', fetch, privateKey: key });
  assert.equal(r.voucher.privateKey, key);
  const tx = parseTransaction(Uint8Array.from(Buffer.from(r.hex, 'hex')));
  assert.equal(Buffer.from(tx.outputs[0].script).toString('hex'), Buffer.from(p2trScript(getPubkey(key))).toString('hex'));
  const waiting = parseFaucet(createFaucet({ chain: 'txbt4', privateKey: key }).uri);
  assert.equal(canAdoptForBootstrap(waiting, []), true);
  assert.equal(canAdoptForBootstrap(waiting, [{ value: 1 }]), false);
  assert.equal(canAdoptForBootstrap(parseFaucet(`txo:txbt4:${txid}:0?amount=5&key=${key}`), []), false);
});

test('latestVersion asks the registry once and never throws; isNewer compares x.y.z', async () => {
  const { latestVersion, isNewer, VERSION } = await import('../index.js');
  const seen = [];
  assert.equal(await latestVersion({ fetch: async (u) => { seen.push(u); return { ok: true, json: async () => ({ version: '0.0.9' }) }; } }), '0.0.9');
  assert.deepEqual(seen, ['https://registry.npmjs.org/fund-agent/latest']);
  assert.equal(await latestVersion({ fetch: async () => { throw new Error('offline'); } }), null);
  assert.equal(await latestVersion({ fetch: async () => ({ ok: false }) }), null);
  assert.equal(await latestVersion({ fetch: async () => ({ ok: true, json: async () => ({ version: 'nope' }) }) }), null);
  assert.equal(isNewer('0.0.8', '0.0.9'), true);
  assert.equal(isNewer('0.0.9', '0.0.9'), false);
  assert.equal(isNewer('0.0.10', '0.0.9'), false);
  assert.equal(isNewer('0.0.9', '0.1.0'), true);
  assert.equal(isNewer(VERSION, null), false);
});

test('init --dry-run writes nothing, with or without a voucher argument', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-agent-'));
  try {
    const file = path.join(dir, 'faucet.txt');
    const bin = new URL('../bin/fund-agent.js', import.meta.url).pathname;
    const env = { ...process.env, FUND_AGENT_FAUCET: file, FUND_AGENT_NO_UPDATE_CHECK: '1' };
    const a = spawnSync(process.execPath, [bin, 'init', '--dry-run'], { env, encoding: 'utf8' });
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /--dry-run: would write a new txbt4 voucher key/);
    assert.equal(fs.existsSync(file), false);
    const b = spawnSync(process.execPath, [bin, 'init', `txo:txbt4:${txid}:0?amount=5000&key=${key}`, '--dry-run'], { env, encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /would store this voucher/);
    assert.doesNotMatch(b.stdout, new RegExp(key));                 // the key is never echoed
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
