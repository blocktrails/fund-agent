#!/usr/bin/env node
// The swap pool daemon: watch the pool key's address on two chains; pay every arrival back to the
// sender's address on the other chain, one to one less a fee. State in a JSON file; one pass with --once.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFaucet, loadVoucher, addressOf, getPubkey, chainInfo } from '../index.js';
import { poolPass, runHook } from '../lib/pool.js';
import { subscribe, publish, verifyEvent, readSwapRequest, buildSwapReply, parseRelays, DEFAULT_RELAYS, KIND_SWAP, hasWebSocket, NO_WEBSOCKET } from '../lib/swap-event.js';
import { poolSnapshot, serveUi } from '../lib/pool-ui.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const keyFile = flag('--key-file', path.join(os.homedir(), '.gitmark', 'swap-pool.txt'));
const chains = flag('--chains', 'txbt4,tbtc4').split(',');
const limits = { fee: Number(flag('--fee', 1000)), max: Number(flag('--max', 1000000)), perDay: Number(flag('--per-day', 10)), reserve: flag('--reserve', '').split(',').filter(Boolean) };
const stateFile = flag('--state', path.join(os.homedir(), '.gitmark', 'swap-pool.state.json'));
const poll = Number(flag('--poll', 30));
const once = args.includes('--once');
const dryRun = args.includes('--dry-run') || args.includes('--dry');
const uiPort = flag('--ui', null);
const onChange = flag('--on-change', null);
let relays = args.includes('--no-nostr') ? [] : (parseRelays(flag('--relays', '')).length ? parseRelays(flag('--relays', '')) : DEFAULT_RELAYS);
if (relays.length && !hasWebSocket()) { console.error(`swap requests off: ${NO_WEBSOCKET} (this is ${process.version}); the poll still finds every deposit`); relays = []; }
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: swap-pool [--key-file ~/.gitmark/swap-pool.txt] [--chains txbt4,tbtc4] [--fee 1000] [--max 1000000] [--per-day 10] [--state file] [--poll 30] [--once] [--dry-run] [--reserve addr,addr] [--ui 3480] [--on-change '<command>'] [--relays wss://a,wss://b | --no-nostr]
Whoever sends to the pool's address on one chain is paid the same amount, less the fee, at the same address on the other.
--on-change runs a command after any pass that paid or refused something (the ledger's publish script, say); the next pass waits for it.
Swap requests (kind 30619 with p = this pool's key) on the relays wake the pool at once; it answers each deposit it pays or refuses.`);
  process.exit(0);
}
if (chains.length !== 2) { console.error('--chains needs exactly two chain ids'); process.exit(1); }
const uri = loadVoucher(keyFile);
if (!uri) { console.error(`No key file at ${keyFile}. Make one with: npx fund-agent init (then move it) or write txo:<chain>?key=<hex>`); process.exit(1); }
const { privateKey } = parseFaucet(uri);
const publicKey = getPubkey(privateKey);
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

log(`pool ${chains.join(' ↔ ')} at ${addressOf(chains[0], publicKey)} (${chainInfo(chains[0]).name} / ${chainInfo(chains[1]).name})`);
log(`fee ${limits.fee} sats, cap ${limits.max} sats per swap, ${limits.perDay} per key per day${limits.reserve.length ? `, reserve from ${limits.reserve.map((a) => a.slice(0, 14) + '…').join(', ')}` : ''}${dryRun ? ', dry run' : ''}`);

const uiCache = {};
if (uiPort) serveUi({ port: Number(uiPort), snapshot: () => poolSnapshot({ publicKey, chains, limits, state, cache: uiCache }), log });

async function pass() {
  let r;
  try {
    r = await poolPass({ privateKey, chains, limits, state, dryRun, log });
    if (!dryRun) save();
  } catch (e) { log(`pass failed: ${e.message}`); return null; }
  if (relays.length && !dryRun && r) await answer(r);
  if (onChange && !dryRun && r && (r.paid.length || r.refused.length)) {
    log(`change: ${r.paid.length} paid, ${r.refused.length} refused; running: ${onChange}`);
    await runHook(onChange, { log });
  }
  return r;
}

// The pool answers every deposit it paid or refused, from its own key, same kind and d as the request
async function answer({ paid, refused }) {
  for (const p of paid) {
    const [chain, txid, vout] = p.key.split(':');
    const ev = buildSwapReply({ privateKey, chain, txid, vout: Number(vout), to: p.to, paid: p.payoutTxid });
    const ok = (await publish(ev, relays)).filter((x) => x.ok).length;
    log(`reply: paid ${txid.slice(0, 12)}… → ${p.payoutTxid.slice(0, 12)}… (${ok}/${relays.length} relays)`);
  }
  for (const r of refused) {
    const [chain, txid, vout] = r.key.split(':');
    const ev = buildSwapReply({ privateKey, chain, txid, vout: Number(vout), to: r.to || '', refused: r.reason });
    const ok = (await publish(ev, relays)).filter((x) => x.ok).length;
    log(`reply: refused ${txid.slice(0, 12)}…: ${r.reason} (${ok}/${relays.length} relays)`);
  }
}

// A swap request for this pool wakes the loop: the next pass starts a moment later, once the
// explorers have seen the deposit, instead of at the next poll. The pass itself verifies everything.
let wake = null;
const seen = new Set();
const xonly = publicKey.length === 66 ? publicKey.slice(2) : publicKey;   // the x-only key, as the address and the p tag spell it
if (relays.length && !once) {
  subscribe({
    relays, log,
    filter: { kinds: [KIND_SWAP], '#p': [xonly], since: Math.floor(Date.now() / 1000) - 600 },
    onEvent(ev) {
      if (seen.has(ev.id) || !verifyEvent(ev)) return;
      seen.add(ev.id);
      const req = readSwapRequest(ev);
      if (!req || req.pool !== xonly || !chains.includes(req.chain) || !chains.includes(req.to)) return;
      if (state.paid?.[`${req.chain}:${req.txid}:${req.vout}`] || state.refused?.[`${req.chain}:${req.txid}:${req.vout}`]) return;
      log(`request: ${req.amount} sats on ${req.chain} → ${req.to}, ${req.txid.slice(0, 12)}…:${req.vout} from ${req.from.slice(0, 12)}…; pass in 3 s`);
      if (wake) setTimeout(wake, 3000);
    },
  });
  log(`listening for swap requests (kind ${KIND_SWAP}, p = ${xonly.slice(0, 12)}…) on ${relays.length} relay${relays.length === 1 ? '' : 's'}`);
}
const sleep = (ms) => new Promise((r) => { let done = false; const once_ = () => { if (!done) { done = true; wake = null; r(); } }; wake = once_; setTimeout(once_, ms); });

if (once) { await pass(); process.exit(0); }
for (;;) { await pass(); await sleep(poll * 1000); }
