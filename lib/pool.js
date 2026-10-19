// A swap pool between two chains that share a key format: whoever sends coins to the pool's address
// on one chain is paid the same amount, less a fee, at the same address on the other chain. The
// sender's address is the return address, so no message is needed. One to one, for test chains.
import { spawn } from 'child_process';
import { chainInfo, lookupUtxos, broadcast, getPubkey, addressOf, existsOnChain, MIN_FEE } from '../index.js';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) { const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1; for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]; } return chk; }
function hrpExpand(hrp) { const r = []; for (const c of hrp) r.push(c.charCodeAt(0) >> 5); r.push(0); for (const c of hrp) r.push(c.charCodeAt(0) & 31); return r; }
function convertBits(data, from, to) { let acc = 0, bits = 0; const r = []; const max = (1 << to) - 1; for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; r.push((acc >> bits) & max); } } return r; }

/**
 * The x-only key inside a raw-key taproot address (bech32m, witness v1, 32-byte program), or null.
 * Only such addresses can be paid on the other chain by key, which is what makes the pool work.
 * @param {string} address
 * @param {string} hrp - 'tb' or 'bc'
 * @returns {string|null} 64-char hex
 */
export function xonlyOfAddress(address, hrp) {
  const a = String(address || '').toLowerCase();
  const sep = a.lastIndexOf('1');
  if (sep <= 0 || a.slice(0, sep) !== hrp) return null;
  const data = [...a.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.length < 7 || data.includes(-1)) return null;
  if (polymod([...hrpExpand(hrp), ...data]) !== 0x2bc830a3) return null;      // bech32m only
  if (data[0] !== 1) return null;
  const prog = convertBits(data.slice(1, -6), 5, 8);
  if (prog.length !== 32) return null;
  return Buffer.from(prog).toString('hex');
}

/** The other side of a two-chain pool */
export function otherChain(chains, chain) {
  const [a, b] = chains;
  if (chain === a) return b;
  if (chain === b) return a;
  throw new Error(`${chain} is not one of the pool's chains`);
}

/**
 * Decide what to do with the coins that arrived at the pool's address on one chain.
 * Pure: no network. Returns payouts to make and refusals to record.
 * @param {object} p
 * @param {string} p.chain - the chain the coins arrived on
 * @param {{txid: string, vout: number, value: number, sender: string|null}[]} p.incoming - arrived coins with the sender address of each
 * @param {string} p.poolAddress
 * @param {object} p.state - {paid: {}, refused: {}, daily: {}}
 * @param {{fee: number, max: number, perDay: number, chains: string[], reserve?: string[]}} p.limits - reserve: addresses whose deposits top the pool up and are never swaps
 * @param {number} [p.now] - ms
 * @returns {{payouts: object[], refusals: object[]}}
 */
export function planSwaps({ chain, incoming, poolAddress, state, limits, now = Date.now() }) {
  const day = new Date(now).toISOString().slice(0, 10);
  const to = otherChain(limits.chains, chain);
  const hrp = chainInfo(to).hrp;
  const payouts = [], refusals = [];
  const dailyCount = { ...(state.daily || {}) };
  for (const c of incoming) {
    const key = `${chain}:${c.txid}:${c.vout}`;
    if (state.paid?.[key] || state.refused?.[key]) continue;            // seen
    if (Object.keys(state.paid || {}).some((k) => k.endsWith(`:${c.txid}:${c.vout}`))) { (state.replayed ||= {})[key] = true; continue; }   // the same deposit on the other chain: a replay, not a second swap
    if (!c.sender || c.sender === poolAddress) continue;                 // our own change or payout, or unknown
    if ((limits.reserve || []).includes(c.sender)) { (state.reserve ||= {})[key] = { value: c.value, at: new Date(now).toISOString() }; continue; }   // the operator topping up
    const pubkey = xonlyOfAddress(c.sender, hrp);
    const dk = `${day}:${c.sender}`;
    let reason = null;
    if (!pubkey) reason = 'sender is not a raw-key taproot address, cannot pay it on the other chain';
    else if (c.value > limits.max) reason = `over the cap of ${limits.max} sats per swap`;
    else if (c.value <= limits.fee + 546) reason = 'too small to cover the fee';
    else if ((dailyCount[dk] || 0) >= limits.perDay) reason = `over ${limits.perDay} swaps today for this key`;
    if (reason) { refusals.push({ key, chain, txid: c.txid, vout: c.vout, value: c.value, sender: c.sender, reason }); continue; }
    dailyCount[dk] = (dailyCount[dk] || 0) + 1;
    payouts.push({ key, from: chain, to, txid: c.txid, vout: c.vout, value: c.value, sender: c.sender, pubkey, amount: c.value - limits.fee });
  }
  return { payouts, refusals, daily: dailyCount };
}

/**
 * Who sent a coin: the address of the transaction's first input, from the explorer's tx view
 * @returns {Promise<string|null>}
 */
export async function senderOf(chainId, txid, { fetch: f = globalThis.fetch } = {}) {
  const res = await f(`${chainInfo(chainId).api}/tx/${txid}`, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const tx = await res.json();
  return tx.vin?.[0]?.prevout?.scriptpubkey_address || null;
}

/**
 * Pay from one of the key's coins on a chain: outputs by x-only pubkey, change back to the key.
 * Signs the unified sighash on the BLAKE2b chains and BIP341 elsewhere. Returns the hex and txid; does not broadcast.
 */
export async function buildPayment({ privateKey, chainId, utxo, outputs }) {
  const chain = chainInfo(chainId);
  const publicKey = getPubkey(privateKey);
  const total = outputs.reduce((a, o) => a + o.amount, 0);
  const change = utxo.value - total - MIN_FEE;
  if (change < 0) throw new Error(`coin ${utxo.txid.slice(0, 12)}… (${utxo.value}) is too small for ${total} + fee`);
  const outs = change >= 546 ? [...outputs, { pubkey: publicKey, amount: change }] : outputs;
  const input = { privateKey, publicKey, txid: utxo.txid, vout: utxo.vout, inputAmount: utxo.value, outputs: outs };
  if (chain.sighash === 'unified') {
    const { buildUnifiedTx } = await import('./tx.js');
    const b = buildUnifiedTx(input);
    return { hex: b.hex, txid: b.txid, change: change >= 546 ? change : 0 };
  }
  const { buildTx } = await import('btctx');
  const b = await buildTx({ ...input, network: chain.network });
  return { hex: b.hex, txid: b.txid, change: change >= 546 ? change : 0 };
}

/** The pool's largest coin on a chain that can cover an amount, confirmed first */
export function pickCoin(utxos, amount) {
  const ok = utxos.filter((u) => u.value >= amount + MIN_FEE).sort((a, b) => (b.confirmed - a.confirmed) || (b.value - a.value));
  return ok[0] || null;
}

/**
 * One pass of the pool over both chains: look, plan, pay, record.
 * @param {object} o
 * @param {string} o.privateKey - the pool key
 * @param {string[]} o.chains - two chain ids
 * @param {{fee: number, max: number, perDay: number}} o.limits
 * @param {object} o.state - mutated: paid, refused, daily
 * @param {boolean} [o.dryRun]
 * @param {(s: string) => void} [o.log]
 * @param {typeof fetch} [o.fetch]
 * @param {Record<string, {chain: string, to: string}>} [o.requests] - swap requests by `<txid>:<vout>`: which chain the deposit was meant on
 * @returns {Promise<{paid: object[], refused: object[], held: object[]}>}
 */
export async function poolPass({ privateKey, chains, limits, state, dryRun = false, log = () => {}, fetch: f = globalThis.fetch, requests = {} }) {
  const publicKey = getPubkey(privateKey);
  const paid = [], refused = [], held = [];
  state.paid ||= {}; state.refused ||= {}; state.daily ||= {};
  for (const chain of chains) {
    const address = addressOf(chain, publicKey);
    let utxos;
    try { utxos = await lookupUtxos(chain, address, { fetch: f }); } catch (e) { log(`${chain}: lookup failed: ${e.message}`); continue; }
    const fresh = utxos.filter((u) => !state.paid[`${chain}:${u.txid}:${u.vout}`] && !state.refused[`${chain}:${u.txid}:${u.vout}`] && !state.own?.[`${chain}:${u.txid}`]);
    const incoming = [];
    const other = otherChain(chains, chain);
    for (const u of fresh) {
      const sender = await senderOf(chain, u.txid, { fetch: f });
      if (sender === address) { (state.own ||= {})[`${chain}:${u.txid}`] = true; continue; }   // our own change: never a swap
      // A BIP341 deposit whose inputs live on both chains is relayed to both, so it arrives here twice,
      // and only the swapper knows which way they meant. Their swap request says; without one, the
      // deposit waits rather than being paid in a direction nobody asked for.
      const req = requests[`${u.txid}:${u.vout}`];
      if (req && req.chain !== chain) { (state.replayed ||= {})[`${chain}:${u.txid}:${u.vout}`] = true; continue; }   // the copy on the chain they did not mean
      if (!req) {
        const twin = await existsOnChain(other, u.txid, { fetch: f });
        if (twin !== false) { held.push({ chain, txid: u.txid, vout: u.vout, value: u.value, sender }); log(`${chain}: deposit ${u.txid.slice(0, 12)}…:${u.vout} ${twin ? 'also exists on ' + other : 'cannot be checked on ' + other}; waiting for a swap request that says which way`); continue; }
      }
      incoming.push({ ...u, sender });
    }
    const plan = planSwaps({ chain, incoming, poolAddress: address, state, limits: { ...limits, chains }, now: Date.now() });
    for (const r of plan.refusals) { state.refused[r.key] = { ...r, at: new Date().toISOString() }; refused.push(r); log(`${chain}: refused ${r.value} sats from ${r.sender.slice(0, 14)}…: ${r.reason}`); }
    for (const p of plan.payouts) {
      const to = p.to;
      let poolCoins;
      try { poolCoins = await lookupUtxos(to, addressOf(to, publicKey), { fetch: f }); } catch (e) { log(`${to}: lookup failed: ${e.message}`); continue; }
      // only coins that live on the paying chain alone: a coin with a twin on the other chain would make the payout replay there
      const safe = [];
      for (const u of poolCoins.filter((u) => !state.paidFrom?.[`${to}:${u.txid}:${u.vout}`])) {
        const twin = await existsOnChain(chain, u.txid, { fetch: f });
        if (twin === false) safe.push(u);
        else log(`${to}: pool coin ${u.txid.slice(0, 12)}…:${u.vout} ${twin ? 'also exists on ' + chain : 'cannot be checked on ' + chain}; not spending it`);
      }
      const coin = pickCoin(safe, p.amount);
      if (!coin) { log(`${to}: no pool coin that lives on ${to} alone can cover ${p.amount} sats for ${p.sender.slice(0, 14)}…; left for the next pass`); continue; }
      const { hex, txid } = await buildPayment({ privateKey, chainId: to, utxo: coin, outputs: [{ pubkey: p.pubkey, amount: p.amount }] });
      if (dryRun) { log(`${chain}→${to}: would pay ${p.amount} sats to ${p.sender.slice(0, 14)}… (tx ${txid.slice(0, 12)}…)`); paid.push({ ...p, payoutTxid: txid, dryRun: true }); continue; }
      const sent = await broadcast(hex, to, { fetch: f });
      state.paid[p.key] = { ...p, payoutTxid: sent, at: new Date().toISOString() };
      (state.paidFrom ||= {})[`${to}:${coin.txid}:${coin.vout}`] = sent;
      state.daily = plan.daily;
      paid.push({ ...p, payoutTxid: sent });
      log(`${chain}→${to}: paid ${p.amount} sats to ${p.sender.slice(0, 14)}… tx ${sent.slice(0, 12)}…`);
    }
  }
  return { paid, refused, held };
}

/**
 * Run a shell command, as the pool does after a pass that changed something. Never throws: the
 * result says how it went, and every output line goes to the log. The pool loop waits for it, so
 * runs never overlap.
 * @param {string} command
 * @param {{cwd?: string, log?: (s: string) => void, timeoutMs?: number, env?: object}} [o]
 * @returns {Promise<{ok: boolean, code: number|null, output: string}>}
 */
export function runHook(command, { cwd = process.cwd(), log = () => {}, timeoutMs = 120_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (ok, code) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok, code, output }); };
    let child;
    try { child = spawn('sh', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { log(`hook: ${e.message}`); return finish(false, null); }
    const timer = setTimeout(() => { log(`hook: timed out after ${timeoutMs / 1000} s; killed`); child.kill('SIGKILL'); }, timeoutMs);
    const onData = (d) => { output += d; for (const line of String(d).split('\n').filter(Boolean)) log(`hook: ${line}`); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { log(`hook: ${e.message}`); finish(false, null); });
    child.on('close', (code) => { if (code !== 0) log(`hook: exit ${code}`); finish(code === 0, code); });
  });
}
