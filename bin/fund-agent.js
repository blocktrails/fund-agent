#!/usr/bin/env node

/**
 * fund-agent - Initialize git config nostr.privkey with funds from a voucher
 *
 * Usage:
 *   npx fund-agent [voucher]
 *   npx fund-agent ~/.gitmark/faucet.txt
 *   npx fund-agent "txo:tbtc4:<txid>:<vout>?amount=<sats>&key=<key>"
 */

import {
  VERSION, CHAINS, DEFAULT_FAUCET,
  isGitRepo, resolveKey, resolveVoucher, parseVoucher, planFunding, fund,
} from '../index.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
fund-agent v${VERSION} - Initialize git config nostr.privkey with funds

Usage:
  npx fund-agent [options] [voucher]

Arguments:
  voucher        TXO voucher URI or path to voucher file
                 Format: txo:<chain>:<txid>:<vout>?amount=<sats>&key=<key>
                 Default: ${DEFAULT_FAUCET}

Options:
  -h, --help     Show this help message
  -v, --version  Show version number
  --global       Store key in global git config (default: local)
  --existing     Fund the existing key instead of generating a new one
  --force        Discard the existing key and generate + fund a new one
  --no-fund      Generate the key only, do not look for a voucher
  --dry-run      Show transaction plan without broadcasting

Chains:
${Object.entries(CHAINS).map(([id, c]) => `  ${id.padEnd(8)} ${c.name}${c.sighash === 'unified' ? ' (unified sighash)' : ''}`).join('\n')}

Examples:
  # Initialize from default faucet
  npx fund-agent

  # Initialize from voucher file
  npx fund-agent ~/.gitmark/faucet.txt

  # Initialize from voucher URI
  npx fund-agent "txo:tbtc4:abc...def:0?amount=5000000&key=123...abc"

  # Fund the existing key (no new key generated)
  npx fund-agent --existing

  # Generate key only (no funding)
  npx fund-agent --no-fund
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

const useGlobal = args.includes('--global');
const force = args.includes('--force');
const existing = args.includes('--existing');
const dryRun = args.includes('--dry-run');
const noFund = args.includes('--no-fund');
const voucherArg = args.find(a => !a.startsWith('-'));

async function main() {
  console.log(`=== fund-agent v${VERSION} ===\n`);

  if (!useGlobal && !isGitRepo()) {
    console.error('Error: Not in a git repository. Use --global for global config.');
    process.exit(1);
  }

  // The voucher first, so a bad argument fails before any key is written
  let v = null;
  if (!noFund) {
    try {
      v = resolveVoucher(voucherArg);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    if (v && v.file === DEFAULT_FAUCET) console.log(`Using default faucet: ${DEFAULT_FAUCET}`);
  }

  const key = resolveKey({ global: useGlobal, existing, force });

  if (key.kept) {
    console.log('This repo already has a key (git config nostr.privkey).');
    console.log(`Public key: ${key.publicKey}`);
    console.log('');
    console.log('To fund this key from a voucher:           re-run with --existing');
    console.log('To replace it with a new funded key:       re-run with --force');
    console.log('Warning: --force permanently discards the existing key.');
    process.exit(0);
  }

  if (key.created) {
    console.log('Generating new keypair...');
    console.log(`Public key: ${key.publicKey}`);
    console.log(`Private key saved to ${useGlobal ? 'global' : 'local'} git config (nostr.privkey)`);
  } else {
    console.log('Funding existing key.');
    console.log(`Public key: ${key.publicKey}`);
    if (!v) {
      console.error('\nError: --existing needs a voucher to fund from.');
      console.error(`  npx fund-agent --existing ${DEFAULT_FAUCET}`);
      process.exit(1);
    }
  }

  if (!v) {
    console.log('\nNo voucher provided. Key saved but wallet not funded.');
    console.log('To fund, run again with a voucher:');
    console.log(`  npx fund-agent ${DEFAULT_FAUCET}`);
    return;
  }

  console.log('\nProcessing voucher...');
  try {
    const voucher = parseVoucher(v.uri);
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
      console.log('\nWarning: Voucher exhausted (no change).');
    }

    console.log('\n=== Agent funded successfully! ===');
  } catch (error) {
    console.error(`\nError processing voucher: ${error.message}`);
    console.log('\nKey was saved. You can fund manually later.');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
