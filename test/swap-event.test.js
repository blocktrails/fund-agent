import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { buildSwapRequest, buildSwapReply, verifyEvent, readSwapRequest, publish, subscribe, parseRelays, KIND_SWAP } from '../lib/swap-event.js';

const sk = bytesToHex(schnorr.utils.randomPrivateKey());
const poolSk = bytesToHex(schnorr.utils.randomPrivateKey());
const poolPub = bytesToHex(schnorr.getPublicKey(poolSk));
const txid = 'ab'.repeat(32);

test('a swap request is a signed, addressable event keyed by the deposit outpoint, addressed to the pool key', () => {
  const ev = buildSwapRequest({ privateKey: sk, poolPubkey: poolPub, chain: 'txbt4', txid, vout: 0, to: 'tbtc4', amount: 8000, createdAt: 1760000000 });
  assert.equal(ev.kind, KIND_SWAP);
  assert.equal(verifyEvent(ev), true);
  assert.deepEqual(ev.tags, [['d', `txbt4:${txid}:0`], ['p', poolPub], ['chain', 'txbt4'], ['to', 'tbtc4'], ['amount', '8000']]);
  const req = readSwapRequest(ev);
  assert.deepEqual({ chain: req.chain, txid: req.txid, vout: req.vout, to: req.to, amount: req.amount, pool: req.pool, hex: req.hex }, { chain: 'txbt4', txid, vout: 0, to: 'tbtc4', amount: 8000, pool: poolPub, hex: null });
  assert.equal(req.from, ev.pubkey);
  const withHex = buildSwapRequest({ privateKey: sk, poolPubkey: poolPub, chain: 'txbt4', txid, vout: 1, to: 'tbtc4', amount: 8000, hex: '0200', createdAt: 1 });
  assert.equal(readSwapRequest(withHex).hex, '0200');
  // tampered: the signature no longer covers it
  assert.equal(verifyEvent({ ...ev, tags: [['d', `txbt4:${txid}:0`], ['p', poolPub], ['chain', 'txbt4'], ['to', 'tbtc4'], ['amount', '9000']] }), false);
  // not a request: no p tag, a bad outpoint, a chain that does not match the d
  assert.equal(readSwapRequest(buildSwapReply({ privateKey: poolSk, chain: 'txbt4', txid, vout: 0, to: 'tbtc4', paid: 'cd'.repeat(32), createdAt: 1 })), null);
  assert.equal(readSwapRequest({ ...ev, tags: [['d', 'nope'], ['p', poolPub], ['chain', 'txbt4'], ['to', 'tbtc4'], ['amount', '1']] }), null);
  assert.equal(readSwapRequest({ ...ev, tags: [['d', `txbt4:${txid}:0`], ['p', poolPub], ['chain', 'tbtc4'], ['to', 'txbt4'], ['amount', '1']] }), null);
});

test('the pool answers from its own key with the same d: paid with the payout txid, or refused with the reason', () => {
  const paid = buildSwapReply({ privateKey: poolSk, chain: 'txbt4', txid, vout: 0, to: 'tbtc4', paid: 'cd'.repeat(32), createdAt: 1760000001 });
  assert.equal(paid.pubkey, poolPub);
  assert.equal(verifyEvent(paid), true);
  assert.deepEqual(paid.tags, [['d', `txbt4:${txid}:0`], ['chain', 'txbt4'], ['to', 'tbtc4'], ['paid', 'cd'.repeat(32)]]);
  const refused = buildSwapReply({ privateKey: poolSk, chain: 'txbt4', txid, vout: 0, to: 'tbtc4', refused: 'over the cap', createdAt: 1 });
  assert.deepEqual(refused.tags.at(-1), ['refused', 'over the cap']);
});

test('parseRelays takes comma or space separated ws(s) urls', () => {
  assert.deepEqual(parseRelays('wss://a, wss://b ws://c http://d'), ['wss://a', 'wss://b', 'ws://c']);
  assert.deepEqual(parseRelays(''), []);
});

class FakeWS {
  static sent = [];
  static opened = [];
  constructor(url) { this.url = url; FakeWS.opened.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
  send(data) {
    const msg = JSON.parse(data); FakeWS.sent.push([this.url, msg]);
    if (msg[0] === 'EVENT') {
      if (this.url.includes('ok')) setTimeout(() => this.onmessage({ data: JSON.stringify(['OK', msg[1].id, true, '']) }), 0);
      else if (this.url.includes('no')) setTimeout(() => this.onmessage({ data: JSON.stringify(['OK', msg[1].id, false, 'blocked']) }), 0);
    }
  }
  close() { this.closed = true; }
}

test('publish sends to every relay and reports OK, refusal or timeout per relay', async () => {
  const ev = buildSwapRequest({ privateKey: sk, poolPubkey: poolPub, chain: 'txbt4', txid, vout: 0, to: 'tbtc4', amount: 8000, createdAt: 1 });
  const r = await publish(ev, ['wss://ok.example', 'wss://no.example', 'wss://silent.example'], { WebSocket: FakeWS, timeout: 50 });
  assert.deepEqual(r.map((x) => [x.ok, x.message]), [[true, ''], [false, 'blocked'], [false, 'timeout']]);
});

test('subscribe sends one REQ per relay with the filter, hands events to onEvent, and closes cleanly', async () => {
  FakeWS.sent = []; FakeWS.opened = [];
  const got = [];
  const s = subscribe({ relays: ['wss://r1.example', 'wss://r2.example'], filter: { kinds: [KIND_SWAP], '#p': [poolPub] }, onEvent: (ev, relay) => got.push([ev.id, relay]), WebSocket: FakeWS });
  await new Promise((r) => setTimeout(r, 10));
  const reqs = FakeWS.sent.filter(([, m]) => m[0] === 'REQ');
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs[0][1][2], { kinds: [KIND_SWAP], '#p': [poolPub] });
  const sub = reqs[0][1][1];
  const ev = buildSwapRequest({ privateKey: sk, poolPubkey: poolPub, chain: 'txbt4', txid, vout: 0, to: 'tbtc4', amount: 8000, createdAt: 1 });
  FakeWS.opened[0].onmessage({ data: JSON.stringify(['EVENT', sub, ev]) });
  FakeWS.opened[0].onmessage({ data: JSON.stringify(['EVENT', 'other-sub', ev]) });
  assert.deepEqual(got, [[ev.id, 'wss://r1.example']]);
  s.close();
  assert.ok(FakeWS.opened.every((w) => w.closed));
});
