#!/usr/bin/env node

/**
 * fund-agent - Initialize git config nostr.privkey with funds from a voucher
 *
 * Usage:
 *   npx fund-agent                 fund this repo's agent from the default voucher file
 *   npx fund-agent init            make a voucher key and print the address to send coins to
 *   npx fund-agent init <voucher>  store a voucher string in the default file
 *   npx fund-agent status          chain, address, balance, agents it funds
 *   npx fund-agent balance         what this repo's agent key holds
 */

import {
  VERSION, CHAINS, DEFAULT_CHAIN, DEFAULT_FAUCET, INIT_AMOUNT, MIN_FEE,
  isGitRepo, resolveKey, resolveVoucher, parseFaucet, createFaucet, refreshVoucher, lookupUtxos, saveVoucher,
  planFunding, agentsFrom, fund, chainInfo, gitConfig, getPubkey, balanceOf, trailTxo, lookupOutput, explorerUrl, consolidate, bootstrap, addressOf, broadcast,
  canAdoptForBootstrap, latestVersion, isNewer,
} from '../index.js';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
fund-agent v${VERSION} - Initialize git config nostr.privkey with funds

Usage:
  npx fund-agent [options] [voucher]      fund this repo's agent
  npx fund-agent init [voucher]           set up the voucher file
  npx fund-agent init --bootstrap         start it from the public bootstrap address (test chains)
  npx fund-agent status                   what the voucher file holds
  npx fund-agent balance                  what this repo's agent key holds
  npx fund-agent consolidate [--dry-run]  merge every coin at the voucher address into one
  npx fund-agent swap <sats> --to <chain> --pool <address>   send sats to a swap pool; the same, less its fee, arrives on the other chain

The voucher file: ${DEFAULT_FAUCET}
  (override with FUND_AGENT_FAUCET=<path>)

Setting up:
  npx fund-agent init                     new key; prints an address, send coins there
  npx fund-agent init --chain xbt         same, for another chain (default ${DEFAULT_CHAIN})
  npx fund-agent init "txo:…?amount=…&key=…"   store a voucher someone gave you

Then, in any repo:
  npx fund-agent                          ${INIT_AMOUNT.toLocaleString()} sats to a new agent key, change stays in the file

Arguments:
  voucher        TXO voucher URI or path to voucher file
                 Format: txo:<chain>:<txid>:<vout>?amount=<sats>&key=<key>

Options:
  -h, --help     Show this help message
  -v, --version  Show version number
  --chain <id>   Chain for a new voucher key (init), or to look on (balance)
  --global       Store key in global git config (default: local)
  --force        Discard the existing key and generate + fund a new one
  --no-fund      Generate the key only, do not look for a voucher
  --dry-run      Show transaction plan without broadcasting (--dry works too)
  --to <chain>   swap: the chain you want coins on; --pool <address> the pool's address (same on both chains)
  --bootstrap    With init: take one coin from the public bootstrap address into a new key of your own

Chains:
${Object.entries(CHAINS).map(([id, c]) => `  ${id.padEnd(8)} ${c.name}${c.sighash === 'unified' ? ' (unified sighash)' : ''}`).join('\n')}
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

const flag = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : null; };
const useGlobal = args.includes('--global');
const force = args.includes('--force');
const dryRun = args.includes('--dry-run') || args.includes('--dry');   // --dry as git mark spells it
const noFund = args.includes('--no-fund');
const useBootstrap = args.includes('--bootstrap');
const chainFlag = flag('--chain');
const positional = args.filter((a, i) => !a.startsWith('-') && !['--chain', '--to', '--pool'].includes(args[i - 1]));
const command = ['init', 'status', 'balance', 'consolidate', 'swap'].includes(positional[0]) ? positional.shift() : 'fund';
const voucherArg = positional[0];

function die(msg) { console.error(`Error: ${msg}`); process.exit(1); }

function describe(voucher) {
  console.log(`Chain:   ${voucher.chain} (${chainInfo(voucher.chain).name})`);
  console.log(`Address: ${voucher.address}`);
  if (voucher.funded) {
    const a = agentsFrom(voucher.amount);
    console.log(`Balance: ${voucher.amount.toLocaleString()} sats at ${voucher.txid}:${voucher.vout}`);
    console.log(`Funds:   ${a.full} agent${a.full === 1 ? '' : 's'} at ${INIT_AMOUNT.toLocaleString()} sats${a.partial ? (a.full ? ' and one smaller' : ' (one agent, below the full amount)') : ''}`);
  }
}

function waitingNotice(voucher, utxos) {
  const pending = utxos.filter((u) => !u.confirmed).reduce((a, u) => a + u.value, 0);
  console.log(`Balance: 0 sats${pending ? ` (${pending.toLocaleString()} sats unconfirmed)` : ''}`);
  console.log(`\nSend coins to ${voucher.address} and run again.`);
}

async function init() {
  let adopt = null;   // a waiting, empty key already in the file: the bootstrap coin goes to it
  if (fs.existsSync(DEFAULT_FAUCET) && fs.readFileSync(DEFAULT_FAUCET, 'utf8').trim()) {
    const cur = parseFaucet(fs.readFileSync(DEFAULT_FAUCET, 'utf8'));
    if (useBootstrap && !cur.funded && !force) {
      let utxos = [];
      try { utxos = await lookupUtxos(cur.chain, cur.address); } catch (e) { die(`Explorer lookup failed: ${e.message}`); }
      if (!canAdoptForBootstrap(cur, utxos)) {
        console.log(`${DEFAULT_FAUCET} holds a key with coins on the way; nothing to bootstrap:`);
        describe(cur);
        console.log('\nRun: npx fund-agent status');
        return;
      }
      if (cur.chain !== (chainFlag || DEFAULT_CHAIN)) die(`The key in ${DEFAULT_FAUCET} is for ${cur.chain}; pass --chain ${cur.chain} or --force`);
      adopt = cur.privateKey;
    } else if (!force) {
      console.log(`${DEFAULT_FAUCET} already holds a voucher${cur.funded ? '' : ' key'}:`);
      describe(cur);
      console.log('\nTo replace it (the old key is lost): re-run init with --force');
      return;
    }
  }
  if (!dryRun) fs.mkdirSync(path.dirname(DEFAULT_FAUCET), { recursive: true });
  let voucher;
  if (useBootstrap) {
    const chain = chainFlag || DEFAULT_CHAIN;
    let r;
    try { r = await bootstrap({ chain, voucherFile: dryRun ? null : DEFAULT_FAUCET, dryRun, ...(adopt ? { privateKey: adopt } : {}) }); } catch (e) { die(e.message); }
    console.log(`Bootstrap: ${r.from.address} (${chain}, public key, anyone may take a coin)`);
    console.log(`Taking:    ${r.coin.value.toLocaleString()} sats  txo:${chain}:${r.coin.txid}:${r.coin.vout}`);
    console.log(`Fee:       ${MIN_FEE.toLocaleString()} sats`);
    console.log(`Yours:     ${r.amount.toLocaleString()} sats, to ${adopt ? `the key already in ${DEFAULT_FAUCET}` : 'a new key'}`);
    if (dryRun) { console.log(`\nRaw: ${r.hex}`); console.log('\n--dry-run: Transaction not broadcast, no file written.'); return; }
    console.log(`\nTransaction broadcast: ${r.txid}`);
    console.log(`Explorer: ${explorerUrl(chain, r.txid)}`);
    fs.chmodSync(DEFAULT_FAUCET, 0o600);
    console.log(`Voucher written to ${DEFAULT_FAUCET}`);
    describe(r.voucher);
    console.log('Then, in any repo: npx fund-agent');
    return;
  }
  if (voucherArg) {
    const isUri = voucherArg.startsWith('txo:') || voucherArg.startsWith('urn:voucher:');
    if (!isUri && !fs.existsSync(voucherArg)) die(`Invalid voucher: must be a txo: URI or a path to a file (${voucherArg})`);
    const raw = (isUri ? voucherArg : fs.readFileSync(voucherArg, 'utf8')).trim();
    voucher = parseFaucet(raw);
    if (dryRun) { console.log(`--dry-run: would store this voucher in ${DEFAULT_FAUCET}; nothing written.`); describe(voucher); return; }
    saveVoucher(voucher.uri, DEFAULT_FAUCET);
    fs.chmodSync(DEFAULT_FAUCET, 0o600);
    console.log(`Voucher stored in ${DEFAULT_FAUCET}`);
    describe(voucher);
    return;
  }
  if (dryRun) {
    console.log(`--dry-run: would write a new ${chainFlag || DEFAULT_CHAIN} voucher key to ${DEFAULT_FAUCET} and print its address; nothing written.`);
    console.log('Without --dry-run, send coins to the printed address, or use --bootstrap on a test chain.');
    return;
  }
  voucher = createFaucet({ chain: chainFlag || DEFAULT_CHAIN });
  saveVoucher(voucher.uri, DEFAULT_FAUCET);
  fs.chmodSync(DEFAULT_FAUCET, 0o600);
  console.log(`New voucher key written to ${DEFAULT_FAUCET}`);
  describe(voucher);
  console.log(`\nSend coins to ${voucher.address}`);
  console.log(`Each agent takes ${INIT_AMOUNT.toLocaleString()} sats plus a ${MIN_FEE.toLocaleString()} sat fee.`);
  console.log('Then, in any repo: npx fund-agent');
}

async function status() {
  const v = resolveVoucher(voucherArg);
  if (!v) { console.log(`No voucher file at ${DEFAULT_FAUCET}. Run: npx fund-agent init`); return; }
  const { voucher, utxos } = await refreshVoucher(v);
  console.log(`File:    ${v.file || '(argument)'}`);
  describe(voucher);
  if (!voucher.funded) waitingNotice(voucher, utxos);
}

async function balance() {
  const privateKey = gitConfig('nostr.privkey') || gitConfig('nostr.privkey', null, true);
  if (!privateKey) die('No agent key in git config (nostr.privkey). Run: npm init agent, then npx fund-agent');
  const chain = chainFlag || gitConfig('gitmark.network') || gitConfig('gitmark.network', null, true) || DEFAULT_CHAIN;
  const b = await balanceOf(chain, getPubkey(privateKey));
  console.log(`Chain:   ${chain} (${chainInfo(chain).name})`);
  console.log(`Address: ${b.address}`);
  for (const u of b.utxos) {
    console.log(`  ${u.value.toLocaleString().padStart(12)} sats  txo:${chain}:${u.txid}:${u.vout}${u.confirmed ? '' : '  (unconfirmed)'}`);
  }
  if (!b.utxos.length) console.log('  no coins');
  console.log(`Balance: ${b.total.toLocaleString()} sats${b.pending ? ` (${b.pending.toLocaleString()} unconfirmed)` : ''}`);

  // After git mark, the coin lives at the trail's current address, not the base one
  const t = trailTxo();
  if (!t) return;
  if (t.chain !== chain) { console.log(`\nTrail:   coin on ${t.chain}, not ${chain} (git config gitmark.txo)`); return; }
  try {
    const o = await lookupOutput(chain, t);
    const uri = `txo:${chain}:${t.txid}:${t.vout}`;
    if (o.spent) console.log(`\nTrail:   ${uri} is spent; run git mark info`);
    else console.log(`\nTrail:   ${o.address}\n  ${o.amount.toLocaleString().padStart(12)} sats  ${uri}${o.confirmed ? '' : '  (unconfirmed)'}${t.commit ? `  commit ${t.commit.slice(0, 8)}` : ''}`);
  } catch (e) {
    console.log(`\nTrail:   txo:${chain}:${t.txid}:${t.vout} (explorer: ${e.message})`);
  }
}

// Send sats from this repo's agent key to a swap pool on the chain it has coins on; the pool pays the
// same amount, less its fee, to this key's address on the other chain, since the address is the same there.
async function swapCmd() {
  const privateKey = gitConfig('nostr.privkey') || gitConfig('nostr.privkey', null, true);
  if (!privateKey) die('No agent key in git config (nostr.privkey). Run: npm create agent@latest');
  const sats = parseInt(positional[0], 10);
  if (!Number.isInteger(sats) || sats <= 0) die('Usage: npx fund-agent swap <sats> --to <chain> --pool <address>');
  const to = flag('--to'); const pool = flag('--pool') || gitConfig('swap.pool') || gitConfig('swap.pool', null, true);
  if (!to) die('--to <chain> is required: the chain you want the coins on');
  if (!pool) die('--pool <address> is required (or git config swap.pool <address>)');
  const from = chainFlag || gitConfig('gitmark.network') || gitConfig('gitmark.network', null, true) || DEFAULT_CHAIN;
  if (from === to) die(`--to must be the other chain; this key is on ${from}`);
  chainInfo(to);
  const { xonlyOfAddress, buildPayment, pickCoin } = await import('../lib/pool.js');
  const poolPub = xonlyOfAddress(pool, chainInfo(from).hrp);
  if (!poolPub) die('The pool address must be a raw-key taproot address for this chain');
  const pubkey = getPubkey(privateKey);
  const address = addressOf(from, pubkey);
  const coins = await lookupUtxos(from, address);
  const coin = pickCoin(coins, sats);
  if (!coin) die(`No coin at ${address} on ${from} covers ${sats.toLocaleString()} sats plus the ${MIN_FEE.toLocaleString()} sat fee`);
  const { hex, txid, change } = await buildPayment({ privateKey, chainId: from, utxo: coin, outputs: [{ pubkey: poolPub, amount: sats }] });
  console.log(`Swap:    ${sats.toLocaleString()} sats on ${from} → the same, less the pool's fee, on ${to}`);
  console.log(`From:    ${address}`);
  console.log(`Pool:    ${pool}`);
  console.log(`Coin:    ${coin.value.toLocaleString()} sats txo:${from}:${coin.txid}:${coin.vout}; change ${change.toLocaleString()} sats; fee ${MIN_FEE.toLocaleString()}`);
  console.log(`Arrives: at ${addressOf(to, pubkey)} on ${to}, within a block`);
  if (dryRun) { console.log(`\nRaw: ${hex}`); console.log('\n--dry-run: Transaction not broadcast.'); return; }
  const sent = await broadcast(hex, from);
  console.log(`\nTransaction broadcast: ${sent}`);
  console.log(`Explorer: ${explorerUrl(from, sent)}`);
  console.log(`Check:    npx fund-agent balance --chain ${to}`);
}

async function consolidateCmd() {
  const v = resolveVoucher(voucherArg);
  if (!v) die(`No voucher file at ${DEFAULT_FAUCET}. Run: npx fund-agent init`);
  const { voucher } = await refreshVoucher(v);
  console.log(`File:    ${v.file || '(argument)'}`);
  console.log(`Chain:   ${voucher.chain} (${chainInfo(voucher.chain).name})`);
  console.log(`Address: ${voucher.address}`);
  let r;
  try {
    r = await consolidate({ voucher, voucherFile: v.file, dryRun });
  } catch (e) { die(e.message); }
  const { plan } = r;
  console.log(`\nMerging ${plan.inputs.length} coins:`);
  for (const u of plan.inputs) console.log(`  ${u.value.toLocaleString().padStart(12)} sats  txo:${voucher.chain}:${u.txid}:${u.vout}${u.confirmed ? '' : '  (unconfirmed)'}`);
  console.log(`  Total:  ${plan.total.toLocaleString()} sats`);
  console.log(`  Fee:    ${plan.fee.toLocaleString()} sats`);
  console.log(`  Output: ${plan.amount.toLocaleString()} sats back to the voucher address`);
  if (dryRun) { console.log(`\nRaw: ${r.hex}`); console.log('\n--dry-run: Transaction not broadcast.'); return; }
  console.log(`\nTransaction broadcast: ${r.txid}`);
  console.log(`Explorer: ${explorerUrl(voucher.chain, r.txid)}`);
  if (v.file) console.log(`Voucher file updated: ${v.file}`);
  else console.log(`Voucher: ${r.newVoucher.replace(/key=[0-9a-f]+/, 'key=…')}`);
}

async function main() {
  console.log(`=== fund-agent v${VERSION} ===\n`);
  // One small registry lookup on init and status: npx keeps old copies around, and an agent cannot tell
  if ((command === 'init' || command === 'status') && !process.env.FUND_AGENT_NO_UPDATE_CHECK) {
    const latest = await latestVersion();
    if (isNewer(VERSION, latest)) console.log(`Note: fund-agent ${latest} is out and you are running ${VERSION}. Use: npx fund-agent@latest\n`);
  }
  if (command === 'init') return init();
  if (command === 'status') return status();
  if (command === 'balance') return balance();
  if (command === 'consolidate') return consolidateCmd();
  if (command === 'swap') return swapCmd();

  if (!useGlobal && !isGitRepo()) die('Not in a git repository. Use --global for global config.');

  // The voucher first, so a bad argument fails before any key is written
  let v = null;
  let voucher = null;
  if (!noFund) {
    v = resolveVoucher(voucherArg);
    if (!v && !voucherArg) {
      // Nothing to fund from yet: make the key and say where to send coins
      await init();
      console.log('\nNo agent key was made. Run again once the coins have arrived.');
      return;
    }
    if (v) {
      if (v.file === DEFAULT_FAUCET) console.log(`Using ${process.env.FUND_AGENT_FAUCET ? 'faucet file (FUND_AGENT_FAUCET)' : 'default faucet'}: ${DEFAULT_FAUCET}`);
      const r = await refreshVoucher(v);
      voucher = r.voucher;
      if (!voucher.funded) {
        describe(voucher);
        waitingNotice(voucher, r.utxos);
        return;
      }
    }
  }

  const key = resolveKey({ global: useGlobal, force });

  if (key.created) {
    console.log('Generating new keypair...');
    console.log(`Public key: ${key.publicKey}`);
    console.log(`Private key saved to ${useGlobal ? 'global' : 'local'} git config (nostr.privkey)`);
  } else {
    console.log('Funding the key in git config (nostr.privkey).');
    console.log(`Public key: ${key.publicKey}`);
  }

  if (!v) {
    console.log('\nNo voucher provided. Key saved but wallet not funded.');
    console.log('To fund, run again with a voucher:');
    console.log(`  npx fund-agent ${DEFAULT_FAUCET}`);
    return;
  }

  console.log('\nProcessing voucher...');
  try {
    const plan = planFunding(voucher);
    console.log(`Chain: ${voucher.chain} (${plan.chain.name})`);
    console.log(`Voucher amount: ${voucher.amount.toLocaleString()} sats`);
    console.log('\nTransaction plan:');
    console.log(`  Input:  ${voucher.amount.toLocaleString()} sats (from voucher)`);
    console.log(`  Output: ${plan.userAmount.toLocaleString()} sats (to you)`);
    if (plan.changeAmount > 0) console.log(`  Change: ${plan.changeAmount.toLocaleString()} sats (back to voucher)`);
    console.log(`  Fee:    ${plan.fee.toLocaleString()} sats`);

    if (dryRun) {
      console.log('\n--dry-run: Transaction not broadcast.');
      return;
    }

    console.log('\nBuilding and broadcasting transaction...');
    const r = await fund({ publicKey: key.publicKey, voucher, voucherFile: v.file, global: useGlobal });
    console.log(`Transaction broadcast: ${r.txid}`);
    console.log(`Explorer: ${r.explorer}`);
    console.log(`\nTXO file ${r.txoCount > 1 ? 'updated' : 'created'}: ${r.txoFile}`);

    if (r.newVoucher) {
      if (v.file) {
        console.log(`Voucher file updated: ${v.file}`);
      } else {
        console.log('\n--- New voucher (save this!) ---');
        console.log(r.newVoucher);
      }
    } else if (v.file) {
      console.log(`\nVoucher exhausted. Its key stays in ${v.file}; send more coins to ${r.address} to fund the next agent.`);
    }

    console.log('\n=== Agent funded successfully! ===');
  } catch (error) {
    console.error(`\nError processing voucher: ${error.message}`);
    console.log('\nKey was saved. You can fund manually later.');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
