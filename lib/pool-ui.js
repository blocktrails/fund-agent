// The pool's own page: what it is, what it holds, what it did. Served by the daemon with --ui <port>.
// One HTML file inline, light palette; the same data as JSON at /pool.json.
import http from 'http';
import { chainInfo, lookupUtxos, addressOf, explorerUrl } from '../index.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sats = (n) => Number(n || 0).toLocaleString();

export async function poolSnapshot({ publicKey, chains, limits, state, cache = {}, ttlMs = 20000 }) {
  const now = Date.now();
  if (cache.at && now - cache.at < ttlMs) return cache.data;
  const address = addressOf(chains[0], publicKey);
  const reserves = {};
  for (const c of chains) {
    try {
      const u = await lookupUtxos(c, addressOf(c, publicKey));
      reserves[c] = { confirmed: u.filter((x) => x.confirmed).reduce((a, x) => a + x.value, 0), pending: u.filter((x) => !x.confirmed).reduce((a, x) => a + x.value, 0), coins: u.length, name: chainInfo(c).name };
    } catch (e) { reserves[c] = { error: e.message, name: chainInfo(c).name }; }
  }
  const swaps = Object.values(state.paid || {}).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const refused = Object.values(state.refused || {}).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const replayed = Object.keys(state.replayed || {});
  const data = { address, chains, limits: { fee: limits.fee, max: limits.max, perDay: limits.perDay }, reserves, swaps, refused, replayed, reserveTopUps: Object.keys(state.reserve || {}).length, at: new Date(now).toISOString() };
  cache.at = now; cache.data = data;
  return data;
}

export function renderPage(d) {
  const rows = d.swaps.map((s) => `<tr><td>${esc((s.at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(s.from)} → ${esc(s.to)}</td><td class="num">${sats(s.value)}</td><td class="num">${sats(s.amount)}</td><td class="mono">${esc(s.sender.slice(0, 12))}…</td><td class="mono"><a href="${esc(explorerUrl(s.from, s.txid))}">in</a> · <a href="${esc(explorerUrl(s.to, s.payoutTxid))}">out</a></td></tr>`).join('');
  const ref = d.refused.map((r) => `<tr class="muted"><td>${esc((r.at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(r.chain)}</td><td class="num">${sats(r.value)}</td><td colspan="3">${esc(r.reason)}</td></tr>`).join('');
  const res = d.chains.map((c) => { const r = d.reserves[c]; return `<tr><td>${esc(c)}<span class="muted"> ${esc(r.name)}</span></td><td class="num">${r.error ? esc(r.error) : sats(r.confirmed)}</td><td class="num muted">${r.error ? '' : sats(r.pending)}</td><td class="mono"><a href="${esc(explorerUrl(c, '').replace(/\/tx\/$/, '/address/') + d.address)}">${esc(d.address.slice(0, 14))}…</a></td></tr>`; }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>swap pool · ${esc(d.chains.join(' ↔ '))}</title>
<meta http-equiv="refresh" content="20">
<style>
*{box-sizing:border-box}body{font-family:Georgia,'Times New Roman',serif;background:#fafaf8;color:#2c2c2c;line-height:1.6;padding:2rem;margin:0}.c{max-width:860px;margin:0 auto}
h1{font-weight:400;font-size:2rem;margin:0 0 .25rem}.sub{color:#666;margin-bottom:1.5rem}h2{color:#f7931a;font-size:1.2rem;font-weight:600;margin:2rem 0 .75rem}
table{width:100%;border-collapse:collapse;font-size:.92rem}th{text-align:left;color:#888;font-weight:500;padding:.5rem .6rem;border-bottom:2px solid #ddd}td{padding:.45rem .6rem;border-bottom:1px solid #eee;vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums}.mono{font-family:'SFMono-Regular',Consolas,monospace;font-size:.85em}.muted{color:#999}a{color:#1a5276}
pre{background:#f0efeb;padding:1rem;border-radius:4px;overflow-x:auto;font-family:'SFMono-Regular',Consolas,monospace;font-size:.85rem}
.box{background:#fff8f0;border:1px solid #f7931a33;border-radius:4px;padding:1rem 1.25rem;margin:1rem 0}.box .l{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#f7931a}
footer{margin-top:2.5rem;color:#999;font-size:.85rem;border-top:1px solid #ddd;padding-top:1rem}
</style></head><body><div class="c">
<h1>swap pool</h1><div class="sub">${esc(d.chains[0])} ↔ ${esc(d.chains[1])} · one to one · fee ${sats(d.limits.fee)} sats · up to ${sats(d.limits.max)} sats a swap, ${d.limits.perDay} a day per key</div>
<div class="box"><div class="l">How to swap</div><p>Send sats from your agent's key to the pool's address on the chain you have coins on. The same amount, less the fee, arrives at your own address on the other chain, because your address is the same string there. No account, no message.</p>
<pre>npx fund-agent@latest swap 8000 --to ${esc(d.chains[1])} --pool ${esc(d.address)}
npx fund-agent@latest swap 4000 --to ${esc(d.chains[0])} --chain ${esc(d.chains[1])} --pool ${esc(d.address)}</pre></div>
<h2>Reserves</h2><table><tr><th>chain</th><th class="num">confirmed</th><th class="num">pending</th><th>address</th></tr>${res}</table>
<h2>Swaps <span class="muted">(${d.swaps.length})</span></h2><table><tr><th>when (UTC)</th><th>direction</th><th class="num">in</th><th class="num">out</th><th>who</th><th>tx</th></tr>${rows || '<tr><td colspan="6" class="muted">none yet</td></tr>'}${ref}</table>
${d.replayed.length ? `<p class="muted">${d.replayed.length} deposit${d.replayed.length === 1 ? '' : 's'} seen on both chains, paid once.</p>` : ''}
<footer>${d.reserveTopUps} reserve top-up${d.reserveTopUps === 1 ? '' : 's'} · snapshot ${esc(d.at.slice(11, 19))} UTC, refreshes every 20 s · <a href="/pool.json">pool.json</a></footer>
</div></body></html>`;
}

/** Serve the page and the JSON on a port; returns the server */
export function serveUi({ port, host = '127.0.0.1', snapshot, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    try {
      const d = await snapshot();
      if (req.url === '/pool.json') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(d, null, 2)); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(renderPage(d));
    } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(e.message); }
  });
  server.listen(port, host, () => log(`ui at http://${host}:${port}/`));
  return server;
}
