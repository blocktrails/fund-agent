// The swap request event: a swapper tells the pool "I sent you this" the moment the deposit is
// broadcast, so the pool pays on its next tick instead of its next poll, and verifiers that never
// poll still see every swap. It never replaces the deposit: the pool pays only after it finds the
// coin on the chain, and the sender is still the deposit's first input, never the event's key.
//
// Kind 30619, addressable, one per deposit: d = <chain>:<txid>:<vout>. Tags p (the pool's x-only
// key, which is the key in its address, so a pool subscribes with #p = itself), chain, to, amount,
// and optionally tx (the raw deposit, for a pool to broadcast if the swapper's broadcast failed).
// The pool answers with the same kind and d from its own key: paid = payout txid, or refused = why.
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export const KIND_SWAP = 30619;
export const DEFAULT_RELAYS = ['wss://nostr.oxtr.dev', 'wss://relay.primal.net', 'wss://relay.snort.social'];
const HEX64 = /^[0-9a-f]{64}$/;
const OUTPOINT = /^([a-z0-9]+):([0-9a-f]{64}):(\d+)$/;

/** Relay list from a config value: comma or whitespace separated, ws(s):// only */
export function parseRelays(value) {
  return String(value || '').split(/[,\s]+/).map((r) => r.trim()).filter((r) => /^wss?:\/\//.test(r));
}

function sign(sk, kind, tags, content, createdAt) {
  const key = hexToBytes(sk);
  const pubkey = bytesToHex(schnorr.getPublicKey(key));
  const created_at = createdAt ?? Math.floor(Date.now() / 1000);
  const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, created_at, kind, tags, content]))));
  return { id, pubkey, created_at, kind, tags, content, sig: bytesToHex(schnorr.sign(id, key)) };
}

/** The request. amount is what was sent to the pool, in sats. */
export function buildSwapRequest({ privateKey, poolPubkey, chain, txid, vout, to, amount, hex, createdAt }) {
  const tags = [['d', `${chain}:${txid}:${vout}`], ['p', poolPubkey], ['chain', chain], ['to', to], ['amount', String(amount)]];
  if (hex) tags.push(['tx', hex]);
  return sign(privateKey, KIND_SWAP, tags, '', createdAt);
}

/** The pool's answer, from the pool key: paid with the payout txid, or refused with the reason. */
export function buildSwapReply({ privateKey, chain, txid, vout, to, paid, refused, createdAt }) {
  const tags = [['d', `${chain}:${txid}:${vout}`], ['chain', chain], ['to', to]];
  if (paid) tags.push(['paid', paid]);
  if (refused) tags.push(['refused', refused]);
  return sign(privateKey, KIND_SWAP, tags, '', createdAt);
}

/** NIP-01: the id is the hash of the canonical form, the sig is over the id. */
export function verifyEvent(ev) {
  if (!ev || typeof ev !== 'object' || !HEX64.test(String(ev.pubkey)) || !HEX64.test(String(ev.id)) || typeof ev.sig !== 'string') return false;
  if (!Number.isInteger(ev.created_at) || !Number.isInteger(ev.kind) || !Array.isArray(ev.tags) || typeof ev.content !== 'string') return false;
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false;
  const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))));
  if (id !== ev.id) return false;
  try { return schnorr.verify(ev.sig, ev.id, ev.pubkey); } catch { return false; }
}

const tag = (ev, n) => { const t = ev.tags.find((x) => x[0] === n); return t ? t[1] : null; };

/** What a request says, or null when it is not one (a reply has no p tag). */
export function readSwapRequest(ev) {
  if (!ev || ev.kind !== KIND_SWAP) return null;
  const m = OUTPOINT.exec(tag(ev, 'd') || '');
  const pool = tag(ev, 'p');
  if (!m || !HEX64.test(pool || '')) return null;
  const chain = tag(ev, 'chain'); const to = tag(ev, 'to'); const amount = Number(tag(ev, 'amount'));
  if (chain !== m[1] || !to || !Number.isInteger(amount) || amount <= 0) return null;
  return { chain, txid: m[2], vout: Number(m[3]), to, amount, pool, hex: tag(ev, 'tx'), from: ev.pubkey, createdAt: ev.created_at, id: ev.id };
}

/** Node's own WebSocket arrived in 22; before that there is nothing to talk to a relay with. */
export const NO_WEBSOCKET = 'no WebSocket in this Node; relays need Node 22 or newer';
export const hasWebSocket = () => typeof globalThis.WebSocket === 'function';

/** Send one event to each relay and wait for its OK. Never throws: one result per relay. */
export function publish(event, relays, { WebSocket: WS = globalThis.WebSocket, timeout = 8000 } = {}) {
  if (typeof WS !== 'function') return Promise.resolve(relays.map((relay) => ({ relay, ok: false, message: NO_WEBSOCKET })));
  return Promise.all(relays.map((relay) => new Promise((resolve) => {
    let done = false;
    const finish = (ok, message) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} resolve({ relay, ok, message }); };
    const timer = setTimeout(() => finish(false, 'timeout'), timeout);
    let ws;
    try { ws = new WS(relay); } catch (e) { return finish(false, e.message); }
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
      if (msg[0] === 'OK' && msg[1] === event.id) finish(!!msg[2], msg[3] || '');
      else if (msg[0] === 'NOTICE') finish(false, String(msg[1] || 'notice'));
    };
    ws.onerror = (e) => finish(false, (e && e.message) || 'connection failed');
    ws.onclose = () => finish(false, 'closed');
  })));
}

/**
 * One socket per relay with one REQ, reconnecting with backoff; every connect re-sends the REQ,
 * which is the catch-up. Returns { close }.
 * @param {{relays: string[], filter: object, onEvent: (ev: object, relay: string) => void, log?: (s: string) => void, WebSocket?: any}} o
 */
export function subscribe({ relays, filter, onEvent, log = () => {}, WebSocket: WS = globalThis.WebSocket }) {
  if (typeof WS !== 'function') { log(NO_WEBSOCKET); return { close() {} }; }
  let closed = false;
  const sockets = new Map();
  const timers = new Set();
  const sub = 'swap-' + Math.random().toString(36).slice(2, 8);
  function connect(relay, attempt = 0) {
    if (closed) return;
    let ws;
    try { ws = new WS(relay); } catch (e) { return retry(relay, attempt, e.message); }
    sockets.set(relay, ws);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', sub, filter]));
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
      // the relay answered the REQ: this connection counts, so the backoff starts over next time
      if (msg[0] === 'EOSE' || msg[0] === 'EVENT') attempt = 0;
      if (msg[0] === 'EVENT' && msg[1] === sub && msg[2]) onEvent(msg[2], relay);
      else if (msg[0] === 'CLOSED' || msg[0] === 'NOTICE') log(`relay ${relay}: ${msg[0]} ${String(msg[msg.length - 1] || '')}`);
    };
    ws.onerror = () => { /* close follows */ };
    ws.onclose = (e) => { sockets.delete(relay); retry(relay, attempt, `closed${e && e.code ? ' ' + e.code : ''}`); };
  }
  function retry(relay, attempt, why) {
    if (closed) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
    if (attempt === 0) log(`relay ${relay} ${why}; reconnecting`);
    const t = setTimeout(() => { timers.delete(t); connect(relay, attempt + 1); }, delay);
    timers.add(t);
  }
  for (const r of relays) connect(r);
  return { close() { closed = true; for (const t of timers) clearTimeout(t); for (const ws of sockets.values()) { try { ws.close(); } catch {} } sockets.clear(); } };
}
