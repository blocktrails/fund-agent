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
  const [a, b] = d.chains;
  const name = (c) => esc(chainInfo(c).name);
  const rows = d.swaps.map((s) => `<tr><td>${esc((s.at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(s.from)} → ${esc(s.to)}</td><td class="num">${sats(s.value)}</td><td class="num">${sats(s.amount)}</td><td class="mono">${esc(s.sender.slice(0, 12))}…</td><td class="mono"><a href="${esc(explorerUrl(s.from, s.txid))}">in</a> · <a href="${esc(explorerUrl(s.to, s.payoutTxid))}">out</a></td></tr>`).join('');
  const ref = d.refused.map((r) => `<tr class="muted"><td>${esc((r.at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(r.chain)}</td><td class="num">${sats(r.value)}</td><td colspan="3">${esc(r.reason)}</td></tr>`).join('');
  const res = d.chains.map((c) => { const r = d.reserves[c]; return `<tr><td>${esc(c)}<span class="muted"> ${esc(r.name)}</span></td><td class="num">${r.error ? esc(r.error) : sats(r.confirmed)}</td><td class="num muted">${r.error ? '' : sats(r.pending)}</td><td class="mono"><a href="${esc(explorerUrl(c, '').replace(/\/tx\/$/, '/address/') + d.address)}">${esc(d.address.slice(0, 14))}…</a></td></tr>`; }).join('');
  const avail = (c) => { const r = d.reserves[c] || {}; return (r.confirmed || 0) + (r.pending || 0); };
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>swap pool · ${esc(a)} ↔ ${esc(b)}</title>
<style>
*{box-sizing:border-box}body{font-family:Georgia,'Times New Roman',serif;background:#fafaf8;color:#2c2c2c;line-height:1.6;padding:2rem;margin:0}.c{max-width:860px;margin:0 auto}
h1{font-weight:400;font-size:2rem;margin:0 0 .25rem}.sub{color:#666;margin-bottom:1.25rem}h2{color:#f7931a;font-size:1.2rem;font-weight:600;margin:2rem 0 .75rem}
table{width:100%;border-collapse:collapse;font-size:.92rem}th{text-align:left;color:#888;font-weight:500;padding:.5rem .6rem;border-bottom:2px solid #ddd}td{padding:.45rem .6rem;border-bottom:1px solid #eee;vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums}.mono{font-family:'SFMono-Regular',Consolas,monospace;font-size:.85em}.muted{color:#999}a{color:#1a5276}
pre{background:#f0efeb;padding:1rem;border-radius:4px;overflow-x:auto;font-family:'SFMono-Regular',Consolas,monospace;font-size:.85rem;margin:.5rem 0 0}
.box{background:#fff8f0;border:1px solid #f7931a33;border-radius:4px;padding:1rem 1.25rem;margin:1rem 0}.box .l{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#f7931a}
footer{margin-top:2.5rem;color:#999;font-size:.85rem;border-top:1px solid #ddd;padding-top:1rem}
.tabs{display:flex;gap:.25rem;margin:0 0 1.5rem;border-bottom:1px solid #ddd}.tabs button{font:inherit;background:none;border:0;border-bottom:2px solid transparent;padding:.5rem 1rem;color:#888;cursor:pointer}.tabs button.on{color:#2c2c2c;border-bottom-color:#f7931a}
.panel{display:none}.panel.on{display:block}
/* the swap card, after the one everyone knows */
.card{max-width:440px;margin:0 auto;background:#fff;border:1px solid #e6e4df;border-radius:20px;padding:12px;box-shadow:0 2px 12px rgba(0,0,0,.04);font-family:-apple-system,'Segoe UI',Inter,Helvetica,Arial,sans-serif}
.card h3{margin:4px 8px 10px;font-size:1rem;font-weight:600}
.tok{background:#f5f4f0;border-radius:16px;padding:14px 16px;margin-bottom:4px;border:1px solid transparent}.tok:focus-within{border-color:#e6e4df;background:#fff}
.tok .lab{font-size:.8rem;color:#777;margin-bottom:6px}.tok .row{display:flex;align-items:center;gap:10px}
.tok input{flex:1;min-width:0;font:inherit;font-size:1.9rem;font-weight:500;border:0;background:none;outline:none;color:#2c2c2c}.tok input::placeholder{color:#bbb}
.pill{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid #e6e4df;border-radius:999px;padding:6px 12px 6px 8px;font-weight:600;font-size:.95rem;white-space:nowrap}.dot{width:22px;height:22px;border-radius:50%;display:inline-block}
.dot.${esc(a)}{background:linear-gradient(135deg,#f7931a,#ffb347)}.dot.${esc(b)}{background:linear-gradient(135deg,#1a5276,#5dade2)}
.tok .bal{font-size:.78rem;color:#999;margin-top:6px;display:flex;justify-content:space-between}
.flip{display:flex;justify-content:center;margin:-10px 0}.flip button{width:40px;height:40px;border-radius:12px;border:4px solid #fff;background:#f5f4f0;font-size:1.1rem;cursor:pointer;color:#555}
.det{font-size:.85rem;color:#777;padding:10px 12px;display:flex;flex-direction:column;gap:4px}.det div{display:flex;justify-content:space-between}
.go{width:100%;font:inherit;font-size:1.15rem;font-weight:600;padding:16px;border:0;border-radius:16px;background:#f7931a;color:#fff;cursor:pointer;margin-top:6px}.go:disabled{background:#e9e7e1;color:#999;cursor:default}
.cmd{display:none;margin-top:10px}.cmd.on{display:block}.cmd p{font-size:.85rem;color:#666;margin:6px 8px}
</style></head><body><div class="c">
<h1>swap pool</h1><div class="sub">${esc(a)} ↔ ${esc(b)} · one to one · fee ${sats(d.limits.fee)} sats · up to ${sats(d.limits.max)} sats a swap, ${d.limits.perDay} a day per key</div>
<div class="tabs"><button class="on" data-tab="swap">Swap</button><button data-tab="pool">Pool</button></div>

<section class="panel on" id="tab-swap">
<div class="card">
<h3>Swap</h3>
<div class="tok"><div class="lab">You pay</div><div class="row"><input id="amt" type="number" inputmode="numeric" min="0" placeholder="at least ${sats(d.limits.fee + 547)}" autocomplete="off"><span class="pill"><span class="dot ${esc(a)}" id="dotFrom"></span><span id="from">${esc(a)}</span></span></div><div class="bal"><span>sats, from your agent's key</span><span>min ${sats(d.limits.fee + 547)} · cap ${sats(d.limits.max)}</span></div></div>
<div class="flip"><button id="flip" title="switch direction" aria-label="switch direction">⇅</button></div>
<div class="tok"><div class="lab">You receive</div><div class="row"><input id="out" type="text" value="0" readonly><span class="pill"><span class="dot ${esc(b)}" id="dotTo"></span><span id="to">${esc(b)}</span></span></div><div class="bal"><span id="sum">amount minus the ${sats(d.limits.fee)} sat fee</span><span>pool has <span id="avail">${sats(avail(b))}</span></span></div></div>
<div class="det"><div><span>Rate</span><span>1 sat = 1 sat</span></div><div><span>Pool fee</span><span>${sats(d.limits.fee)} sats</span></div><div><span>Network fee</span><span>1,000 sats, paid by your spend</span></div><div><span>Arrives</span><span>within a block</span></div></div>
<button class="go" id="go" disabled>Enter an amount</button>
<div class="cmd" id="cmd"><p>Your key is in your repo, not in this page, so the spend is one command there:</p><pre id="cmdText"></pre><p>The daemon sees it on the next pass and pays the other side.</p></div>
</div>
</section>

<section class="panel" id="tab-pool">
<div class="box"><div class="l">How it works</div><p>Send sats from your agent's key to the pool's address on the chain you have coins on. The same amount, less the fee, arrives at your own address on the other chain, because your address is the same string there. No account, no message.</p>
<pre>npx fund-agent@latest swap 8000 --to ${esc(b)} --pool ${esc(d.address)}
npx fund-agent@latest swap 4000 --to ${esc(a)} --chain ${esc(b)} --pool ${esc(d.address)}</pre></div>
<h2>Reserves</h2><table><tr><th>chain</th><th class="num">confirmed</th><th class="num">pending</th><th>address</th></tr>${res}</table>
<h2>Swaps <span class="muted">(${d.swaps.length})</span></h2><table><tr><th>when (UTC)</th><th>direction</th><th class="num">in</th><th class="num">out</th><th>who</th><th>tx</th></tr>${rows || '<tr><td colspan="6" class="muted">none yet</td></tr>'}${ref}</table>
${d.replayed.length ? `<p class="muted">${d.replayed.length} deposit${d.replayed.length === 1 ? '' : 's'} seen on both chains, paid once.</p>` : ''}
</section>

<footer>${d.reserveTopUps} reserve top-up${d.reserveTopUps === 1 ? '' : 's'} · snapshot ${esc(d.at.slice(11, 19))} UTC · <a href="/pool.json">pool.json</a></footer>
</div>
<script>
(function(){
  var chains=${JSON.stringify(d.chains)}, avail=${JSON.stringify({ [a]: avail(a), [b]: avail(b) })}, fee=${Number(d.limits.fee)}, max=${Number(d.limits.max)}, pool=${JSON.stringify(d.address)};
  var from=chains[0], to=chains[1];
  var $=function(id){return document.getElementById(id)};
  function fmt(n){return n.toLocaleString()}
  function render(){
    $('from').textContent=from; $('to').textContent=to; $('dotFrom').className='dot '+from; $('dotTo').className='dot '+to; $('avail').textContent=fmt(avail[to]||0);
    var amt=Math.floor(Number($('amt').value)||0), out=Math.max(0, amt-fee), go=$('go'), ok=amt>fee+546 && amt<=max && out<=(avail[to]||0);
    $('out').value=fmt(out);
    $('sum').textContent=amt?fmt(amt)+' − '+fmt(fee)+' fee = '+fmt(out)+', at your own address':'amount minus the '+fmt(fee)+' sat fee';
    go.disabled=!ok; go.textContent=!amt?'Enter an amount':amt>max?'Over the cap of '+fmt(max)+' sats':amt<=fee+546?'Too small to cover the fee':out>(avail[to]||0)?'Pool has only '+fmt(avail[to]||0)+' on '+to:'Swap';
    $('cmdText').textContent='npx fund-agent@latest swap '+amt+' --to '+to+(from!==chains[0]?' --chain '+from:'')+' --pool '+pool;
    if(!ok) $('cmd').classList.remove('on');
  }
  $('amt').addEventListener('input', render);
  $('flip').addEventListener('click', function(){ var t=from; from=to; to=t; render(); });
  $('go').addEventListener('click', function(){ $('cmd').classList.add('on'); });
  document.querySelectorAll('.tabs button').forEach(function(b){ b.addEventListener('click', function(){
    document.querySelectorAll('.tabs button').forEach(function(x){x.classList.toggle('on', x===b)});
    document.querySelectorAll('.panel').forEach(function(p){p.classList.toggle('on', p.id==='tab-'+b.dataset.tab)});
    try{ localStorage.setItem('pool-tab', b.dataset.tab) }catch(e){}
  })});
  try{ var t=localStorage.getItem('pool-tab'); if(t){ var b=document.querySelector('.tabs button[data-tab="'+t+'"]'); if(b) b.click(); } }catch(e){}
  render();
  setTimeout(function(){ if(!document.activeElement || document.activeElement.id!=='amt') location.reload(); }, 30000);
})();
</script></body></html>`;
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
