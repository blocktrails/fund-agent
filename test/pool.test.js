import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xonlyOfAddress, otherChain, planSwaps, pickCoin, buildPayment, poolPass, runHook } from '../lib/pool.js';
import { addressOf, getPubkey, MIN_FEE } from '../index.js';

const key = 'ab'.repeat(32);
const pub = getPubkey(key);
const other = getPubkey('cd'.repeat(32));

test('xonlyOfAddress reads the key out of a raw-key taproot address and nothing else', () => {
  assert.equal(xonlyOfAddress(addressOf('txbt4', pub), 'tb'), pub);
  assert.equal(xonlyOfAddress(addressOf('txbt4', pub), 'bc'), null);           // wrong chain
  assert.equal(xonlyOfAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'tb'), null);  // v0, bech32
  assert.equal(xonlyOfAddress('nonsense', 'tb'), null);
  assert.equal(otherChain(['txbt4', 'tbtc4'], 'tbtc4'), 'txbt4');
  assert.throws(() => otherChain(['txbt4', 'tbtc4'], 'btc'));
});

test('planSwaps: pays the sender on the other chain less the fee; skips own change, seen coins, caps and odd senders', () => {
  const pool = addressOf('txbt4', pub);
  const sender = addressOf('txbt4', other);
  const limits = { fee: 1000, max: 1000000, perDay: 2, chains: ['txbt4', 'tbtc4'] };
  const incoming = [
    { txid: '11'.repeat(32), vout: 0, value: 50000, sender },                 // pay
    { txid: '22'.repeat(32), vout: 1, value: 5000000, sender },               // over cap
    { txid: '33'.repeat(32), vout: 0, value: 1200, sender },                  // too small
    { txid: '44'.repeat(32), vout: 0, value: 60000, sender: pool },           // our own change
    { txid: '55'.repeat(32), vout: 0, value: 60000, sender: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }, // not taproot
    { txid: '66'.repeat(32), vout: 0, value: 70000, sender },                 // pay (2nd today)
    { txid: '77'.repeat(32), vout: 0, value: 80000, sender },                 // 3rd today: over per-day
    { txid: '88'.repeat(32), vout: 0, value: 90000, sender: null },           // unknown sender
  ];
  const state = { paid: { ['txbt4:' + '99'.repeat(32) + ':0']: {} }, refused: {}, daily: {} };
  const reserveAddr = addressOf('txbt4', getPubkey('ef'.repeat(32)));
  const r = planSwaps({ chain: 'txbt4', incoming: [...incoming, { txid: '99'.repeat(32), vout: 0, value: 50000, sender }, { txid: 'aa'.repeat(32), vout: 0, value: 1000000000, sender: reserveAddr }], poolAddress: pool, state, limits: { ...limits, reserve: [reserveAddr] }, now: Date.UTC(2026, 9, 19) });
  assert.ok(state.reserve[`txbt4:${'aa'.repeat(32)}:0`]);                     // a top-up from the operator is reserve, not a swap
  assert.deepEqual(r.payouts.map((p) => [p.txid.slice(0, 2), p.to, p.amount, p.pubkey === other]), [['11', 'tbtc4', 49000, true], ['66', 'tbtc4', 69000, true]]);
  assert.deepEqual(r.refusals.map((x) => [x.txid.slice(0, 2), x.reason.split(' ').slice(0, 3).join(' ')]), [['22', 'over the cap'], ['33', 'too small to'], ['55', 'sender is not'], ['77', 'over 2 swaps']]);
  assert.equal(r.daily[`2026-10-19:${sender}`], 2);
});

test('pickCoin prefers confirmed then largest among coins that cover the amount', () => {
  const coins = [{ txid: 'a', vout: 0, value: 5000, confirmed: true }, { txid: 'b', vout: 0, value: 90000, confirmed: false }, { txid: 'c', vout: 0, value: 70000, confirmed: true }];
  assert.equal(pickCoin(coins, 10000).txid, 'c');
  assert.equal(pickCoin(coins, 80000).txid, 'b');
  assert.equal(pickCoin(coins, 500000), null);
});

test('buildPayment signs unified on txbt4 and BIP341 on tbtc4, with change back to the key', async () => {
  const { parseTransaction } = await import('../lib/unified.js');
  const u = await buildPayment({ privateKey: key, chainId: 'txbt4', utxo: { txid: 'ab'.repeat(32), vout: 0, value: 100000 }, outputs: [{ pubkey: other, amount: 49000 }] });
  const tx = parseTransaction(Uint8Array.from(Buffer.from(u.hex, 'hex')));
  assert.equal(tx.outputs.length, 2);
  assert.equal(tx.outputs[0].value, 49000n);
  assert.equal(tx.outputs[1].value, BigInt(100000 - 49000 - MIN_FEE));
  assert.equal(tx.inputs[0].witness[0][64], 0x21);
  const c = await buildPayment({ privateKey: key, chainId: 'tbtc4', utxo: { txid: 'ab'.repeat(32), vout: 0, value: 100000 }, outputs: [{ pubkey: other, amount: 49000 }] });
  const tx2 = parseTransaction(Uint8Array.from(Buffer.from(c.hex, 'hex')));
  assert.equal(tx2.inputs[0].witness[0].length, 64);                          // BIP341 default sighash: no hash type byte
  assert.equal(u.change, 100000 - 49000 - MIN_FEE);
});

test('poolPass: an arrival on txbt4 is paid on tbtc4 from the pool coin there, recorded, and never paid twice', async () => {
  const poolTx = addressOf('txbt4', pub);   // same string on tbtc4
  const sender = addressOf('txbt4', other);
  const posted = [];
  const fetch = async (url, init = {}) => {
    if (init.method === 'POST') { posted.push(url); return { ok: true, status: 200, text: async () => 'ee'.repeat(32) }; }
    if (url.includes('mempool.guide') && url.endsWith(`/address/${poolTx}/utxo`)) return { ok: true, json: async () => [{ txid: '11'.repeat(32), vout: 0, value: 50000, status: { confirmed: true } }] };
    if (url.includes('mempool.space') && url.endsWith(`/address/${poolTx}/utxo`)) return { ok: true, json: async () => [{ txid: '22'.repeat(32), vout: 0, value: 400000, status: { confirmed: true } }] };
    if (url.endsWith(`/tx/${'11'.repeat(32)}`)) return { ok: true, json: async () => ({ vin: [{ prevout: { scriptpubkey_address: sender } }] }) };
    if (url.includes('mempool.guide') && url.endsWith(`/tx/${'22'.repeat(32)}`)) return { ok: false, status: 404 };   // the pool's tbtc4 coin is unknown on txbt4
    if (url.endsWith(`/tx/${'22'.repeat(32)}`)) return { ok: true, json: async () => ({ vin: [{ prevout: { scriptpubkey_address: 'tb1psomeoneelse' } }] }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const state = {}; const logs = [];
  const r = await poolPass({ privateKey: key, chains: ['txbt4', 'tbtc4'], limits: { fee: 1000, max: 1000000, perDay: 10 }, state, log: (s) => logs.push(s), fetch });
  assert.equal(r.paid.length, 1);
  assert.equal(r.paid[0].amount, 49000);
  assert.equal(r.paid[0].to, 'tbtc4');
  assert.equal(posted.length, 1);
  assert.ok(posted[0].includes('mempool.space'));                             // paid on the other chain
  assert.ok(state.paid[`txbt4:${'11'.repeat(32)}:0`]);
  const again = await poolPass({ privateKey: key, chains: ['txbt4', 'tbtc4'], limits: { fee: 1000, max: 1000000, perDay: 10 }, state, log: () => {}, fetch });
  assert.equal(again.paid.length, 0);
  assert.equal(posted.length, 1);
});

test('poolPass never pays from a coin that also exists on the other chain, and a replayed deposit is not a second swap', async () => {
  const pool = addressOf('txbt4', pub);
  const sender = addressOf('txbt4', other);
  const posted = [];
  const fetch = async (url, init = {}) => {
    if (init.method === 'POST') { posted.push(url); return { ok: true, status: 200, text: async () => 'ee'.repeat(32) }; }
    if (url.endsWith(`/address/${pool}/utxo`)) return { ok: true, json: async () => [{ txid: '11'.repeat(32), vout: 0, value: 50000, status: { confirmed: true } }, { txid: '22'.repeat(32), vout: 0, value: 400000, status: { confirmed: true } }] };  // same coins on both chains: twins
    if (url.endsWith(`/tx/${'11'.repeat(32)}`)) return { ok: true, json: async () => ({ vin: [{ prevout: { scriptpubkey_address: sender } }] }) };
    if (url.endsWith(`/tx/${'22'.repeat(32)}`)) return { ok: true, status: 200, json: async () => ({ vin: [{ prevout: { scriptpubkey_address: 'tb1pelse' } }], vout: [{}] }) };   // known on both chains: a twin
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const state = {}; const logs = [];
  const r = await poolPass({ privateKey: key, chains: ['txbt4', 'tbtc4'], limits: { fee: 1000, max: 1000000, perDay: 10 }, state, log: (s) => logs.push(s), fetch });
  assert.equal(r.paid.length, 0);
  assert.equal(posted.length, 0);
  assert.ok(logs.some((l) => /also exists on/.test(l)));
  // and if the deposit 11… had been paid from txbt4 already, seeing it on tbtc4 is a replay, not a swap
  const state2 = { paid: { ['txbt4:' + '11'.repeat(32) + ':0']: { amount: 49000 } } };
  const plan = planSwaps({ chain: 'tbtc4', incoming: [{ txid: '11'.repeat(32), vout: 0, value: 50000, sender }], poolAddress: pool, state: state2, limits: { fee: 1000, max: 1000000, perDay: 10, chains: ['txbt4', 'tbtc4'] } });
  assert.equal(plan.payouts.length, 0);
  assert.ok(state2.replayed['tbtc4:' + '11'.repeat(32) + ':0']);
});

test('the pool page renders reserves, swaps and the swap command from a snapshot', async () => {
  const { renderPage } = await import('../lib/pool-ui.js');
  const html = renderPage({ address: addressOf('txbt4', pub), chains: ['txbt4', 'tbtc4'], limits: { fee: 1000, max: 1000000, perDay: 10 },
    reserves: { txbt4: { confirmed: 1000000000, pending: 0, coins: 1, name: 'Bitcoin BLAKE2b testnet4' }, tbtc4: { confirmed: 0, pending: 999993000, coins: 1, name: 'Bitcoin testnet4' } },
    swaps: [{ at: '2026-10-19T10:08:07Z', from: 'txbt4', to: 'tbtc4', value: 5000, amount: 4000, sender: addressOf('txbt4', other), txid: '11'.repeat(32), payoutTxid: '22'.repeat(32) }],
    refused: [{ at: '2026-10-19T10:09:00Z', chain: 'txbt4', value: 5000000, reason: 'over the cap of 1000000 sats per swap' }], replayed: ['x'], reserveTopUps: 2, at: '2026-10-19T10:10:00.000Z' });
  assert.match(html, /1,000,000,000/);
  assert.match(html, /999,993,000/);
  assert.match(html, new RegExp(`--pool ${addressOf('txbt4', pub)}`));
  assert.match(html, /txbt4 → tbtc4/);
  assert.match(html, /over the cap/);
  assert.match(html, /1 deposit seen on both chains/);
  assert.match(html, /data-tab="swap"/);
  assert.match(html, /You receive/);
  assert.match(html, /id="flip"/);
});

test('runHook runs a shell command, logs its lines, reports failure without throwing', async () => {
  const lines = [];
  const ok = await runHook('echo one; echo two 1>&2', { log: (l) => lines.push(l) });
  assert.equal(ok.ok, true);
  assert.deepEqual(lines, ['hook: one', 'hook: two']);
  const bad = await runHook('echo nope; exit 3', { log: (l) => lines.push(l) });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 3);
  assert.ok(lines.includes('hook: exit 3'));
  const slow = await runHook('sleep 5', { log: () => {}, timeoutMs: 200 });
  assert.equal(slow.ok, false);
});
