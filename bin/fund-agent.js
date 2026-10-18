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
  planFunding, agentsFrom, fund, chainInfo, gitConfig, getPubkey, balanceOf, trailTxo, lookupOutput, explorerUrl, consolidate,
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
  npx fund-agent status                   what the voucher file holds
  npx fund-agent balance                  what this repo's agent key holds
  npx fund-agent consolidate [--dry-run]  merge every coin at the voucher address into one

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
  --dry-run      Show transaction plan without broadcasting

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
const dryRun = args.includes('--dry-run');
const noFund = args.includes('--no-fund');
const chainFlag = flag('--chain');
const positional = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--chain');
const command = ['init', 'status', 'balance', 'consolidate'].includes(positional[0]) ? positional.shift() : 'fund';
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
  if (fs.existsSync(DEFAULT_FAUCET) && fs.readFileSync(DEFAULT_FAUCET, 'utf8').trim()) {
    const cur = parseFaucet(fs.readFileSync(DEFAULT_FAUCET, 'utf8'));
    if (!force) {
      console.log(`${DEFAULT_FAUCET} already holds a voucher${cur.funded ? '' : ' key'}:`);
      describe(cur);
      console.log('\nTo replace it (the old key is lost): re-run init with --force');
      return;
    }
  }
  fs.mkdirSync(path.dirname(DEFAULT_FAUCET), { recursive: true });
  let voucher;
  if (voucherArg) {
    const isUri = voucherArg.startsWith('txo:') || voucherArg.startsWith('urn:voucher:');
    if (!isUri && !fs.existsSync(voucherArg)) die(`Invalid voucher: must be a txo: URI or a path to a file (${voucherArg})`);
    const raw = (isUri ? voucherArg : fs.readFileSync(voucherArg, 'utf8')).trim();
    voucher = parseFaucet(raw);
    saveVoucher(voucher.uri, DEFAULT_FAUCET);
    fs.chmodSync(DEFAULT_FAUCET, 0o600);
    console.log(`Voucher stored in ${DEFAULT_FAUCET}`);
    describe(voucher);
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
  for (const u of plan.inputs) console.log(`  ${u.value.toLocaleString().padStart(12)} sats  txo:${voucher.chain}:${u.txid}:${u.vout}`);
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
  if (command === 'init') return init();
  if (command === 'status') return status();
  if (command === 'balance') return balance();
  if (command === 'consolidate') return consolidateCmd();

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
      if (v.file === DEFAULT_FAUCET) console.log(`Using default faucet: ${DEFAULT_FAUCET}`);
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
