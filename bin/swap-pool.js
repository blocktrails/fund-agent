#!/usr/bin/env node
// The swap pool daemon: watch the pool key's address on two chains; pay every arrival back to the
// sender's address on the other chain, one to one less a fee. State in a JSON file; one pass with --once.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFaucet, loadVoucher, addressOf, getPubkey, chainInfo } from '../index.js';
import { poolPass } from '../lib/pool.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const keyFile = flag('--key-file', path.join(os.homedir(), '.gitmark', 'swap-pool.txt'));
const chains = flag('--chains', 'txbt4,tbtc4').split(',');
const limits = { fee: Number(flag('--fee', 1000)), max: Number(flag('--max', 1000000)), perDay: Number(flag('--per-day', 10)), reserve: flag('--reserve', '').split(',').filter(Boolean) };
const stateFile = flag('--state', path.join(os.homedir(), '.gitmark', 'swap-pool.state.json'));
const poll = Number(flag('--poll', 30));
const once = args.includes('--once');
const dryRun = args.includes('--dry-run') || args.includes('--dry');
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: swap-pool [--key-file ~/.gitmark/swap-pool.txt] [--chains txbt4,tbtc4] [--fee 1000] [--max 1000000] [--per-day 10] [--state file] [--poll 30] [--once] [--dry-run] [--reserve addr,addr]
Whoever sends to the pool's address on one chain is paid the same amount, less the fee, at the same address on the other.`);
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

async function pass() {
  try {
    const r = await poolPass({ privateKey, chains, limits, state, dryRun, log });
    if (!dryRun) save();
    return r;
  } catch (e) { log(`pass failed: ${e.message}`); return null; }
}
if (once) { await pass(); process.exit(0); }
for (;;) { await pass(); await new Promise((r) => setTimeout(r, poll * 1000)); }
