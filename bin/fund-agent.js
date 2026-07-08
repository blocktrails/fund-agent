#!/usr/bin/env node

/**
 * fund-agent - Initialize git config nostr.privkey with funds from a voucher
 *
 * Usage:
 *   npx fund-agent [voucher]
 *   npx fund-agent ~/.gitmark/faucet.txt
 *   npx fund-agent "txo:tbtc4:<txid>:<vout>?amount=<sats>&key=<key>"
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getPublicKey } from '@noble/secp256k1';
import crypto from 'crypto';

// Constants
const INIT_AMOUNT = 1000000;  // 1M sats (0.01 BTC)
const MIN_FEE = 1000;
const DEFAULT_FAUCET = path.join(os.homedir(), '.gitmark', 'faucet.txt');
// Networks accepted in a voucher's chain segment (see README "Networks").
const KNOWN_CHAINS = new Set(['tbtc4', 'btc', 'signet']);

// CLI args
const args = process.argv.slice(2);

// Help
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
fund-agent v0.0.2 - Initialize git config nostr.privkey with funds

Usage:
  npx fund-agent [options] [voucher]

Arguments:
  voucher        TXO voucher URI or path to voucher file
                 Format: txo:<chain>:<txid>:<vout>?amount=<sats>&key=<key>
                 Default: ~/.gitmark/faucet.txt

Options:
  -h, --help     Show this help message
  -v, --version  Show version number
  --global       Store key in global git config (default: local)
  --existing     Fund the existing key instead of generating a new one
  --force        Discard the existing key and generate + fund a new one
  --dry-run      Show transaction plan without broadcasting

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

// Version
if (args.includes('--version') || args.includes('-v')) {
  console.log('0.0.2');
  process.exit(0);
}

// Parse flags
const useGlobal = args.includes('--global');
const force = args.includes('--force');
const useExisting = args.includes('--existing');
const dryRun = args.includes('--dry-run');
const noFund = args.includes('--no-fund');

// Helper: get x-only pubkey from privkey
function getPubkey(privkey) {
  const compressed = getPublicKey(privkey, true);
  return Buffer.from(compressed.slice(1)).toString('hex');
}

// Helper: generate random private key
function generatePrivateKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Helper: get/set git config.
// Uses execFileSync so key/value are passed to git as argv, never
// through a shell — a voucher-supplied value like `$(...)` cannot
// execute. `--` separates options from the value so a value beginning
// with `-` is treated as data, not a git-config flag.
function gitConfig(key, value = null, global = false) {
  const scope = global ? '--global' : '--local';
  try {
    if (value === null) {
      return execFileSync('git', ['config', scope, key], { encoding: 'utf8' }).trim();
    } else {
      execFileSync('git', ['config', scope, '--', key, value]);
      return value;
    }
  } catch {
    return null;
  }
}

// Helper: check if in git repo
function isGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Helper: parse voucher URI
function parseVoucher(uri) {
  let normalized = uri;
  if (uri.startsWith('urn:voucher:txo:')) {
    normalized = uri.slice('urn:voucher:'.length);
  }

  if (!normalized.startsWith('txo:')) {
    throw new Error('Invalid voucher format: must start with txo:');
  }

  const [pathPart, query] = normalized.split('?');
  const [, chain, txid, voutStr] = pathPart.split(':');
  const vout = parseInt(voutStr, 10);

  // Validate the parts that later reach git config / URLs. The chain is
  // an allowlisted network name and the txid a hex string; rejecting
  // anything else keeps voucher-supplied values from doing something
  // surprising downstream.
  if (!KNOWN_CHAINS.has(chain)) {
    throw new Error(`Invalid voucher: unknown chain "${chain}"`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new Error('Invalid voucher: txid must be 64 hex characters');
  }

  const params = {};
  if (query) {
    for (const pair of query.split('&')) {
      const [key, value] = pair.split('=');
      params[key] = decodeURIComponent(value);
    }
  }

  if (!params.key) throw new Error('Invalid voucher: missing key parameter');
  if (!params.amount) throw new Error('Invalid voucher: missing amount parameter');

  return {
    chain,
    txid,
    vout,
    privateKey: params.key,
    amount: parseInt(params.amount, 10),
  };
}

// Helper: create voucher URI
function createVoucher({ chain, txid, vout, privateKey, amount }) {
  return `txo:${chain}:${txid}:${vout}?amount=${amount}&key=${privateKey}`;
}

// Helper: load voucher from file
function loadVoucher(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

// Helper: save voucher to file
function saveVoucher(uri, filePath) {
  fs.writeFileSync(filePath, uri + '\n');
}

// Find voucher argument
const voucherArgRaw = args.find(a =>
  !a.startsWith('-') &&
  a !== '--global' &&
  a !== '--force' &&
  a !== '--dry-run' &&
  a !== '--no-fund'
);

// Resolve voucher
let voucherArg = null;
let voucherFile = null;

if (noFund) {
  // No funding requested
} else if (voucherArgRaw) {
  if (voucherArgRaw.startsWith('txo:') || voucherArgRaw.startsWith('urn:voucher:')) {
    voucherArg = voucherArgRaw;
  } else if (fs.existsSync(voucherArgRaw)) {
    voucherFile = voucherArgRaw;
    voucherArg = loadVoucher(voucherFile);
    if (!voucherArg) {
      console.error(`Error: Could not read voucher from file: ${voucherFile}`);
      process.exit(1);
    }
  } else {
    console.error(`Error: Invalid voucher. Must be a txo: URI or a file path.`);
    process.exit(1);
  }
} else if (fs.existsSync(DEFAULT_FAUCET)) {
  voucherFile = DEFAULT_FAUCET;
  voucherArg = loadVoucher(voucherFile);
  if (voucherArg) {
    console.log(`Using default faucet: ${DEFAULT_FAUCET}`);
  }
}

async function main() {
  console.log('=== fund-agent v0.0.2 ===\n');

  // Check if in git repo (unless using global)
  if (!useGlobal && !isGitRepo()) {
    console.error('Error: Not in a git repository. Use --global for global config.');
    process.exit(1);
  }

  // Check for existing key
  const existingKey = gitConfig('nostr.privkey') || gitConfig('nostr.privkey', null, true);

  let privateKey, publicKey;

  if (existingKey && useExisting) {
    // Fund the existing key — no new key generated
    privateKey = existingKey;
    publicKey = getPubkey(privateKey);
    console.log('Funding existing key.');
    console.log(`Public key: ${publicKey}`);

    if (!voucherArg) {
      console.error('\nError: --existing needs a voucher to fund from.');
      console.error('  npx fund-agent --existing ~/.gitmark/faucet.txt');
      process.exit(1);
    }
  } else if (existingKey && !force) {
    console.log('This repo already has a key (git config nostr.privkey).');
    console.log(`Public key: ${getPubkey(existingKey)}`);
    console.log('');
    console.log('To fund this key from a voucher:           re-run with --existing');
    console.log('To replace it with a new funded key:       re-run with --force');
    console.log('Warning: --force permanently discards the existing key.');
    process.exit(0);
  } else {
    // Generate new keypair
    console.log('Generating new keypair...');
    privateKey = generatePrivateKey();
    publicKey = getPubkey(privateKey);
    console.log(`Public key: ${publicKey}`);

    // Save to git config
    const scope = useGlobal ? 'global' : 'local';
    gitConfig('nostr.privkey', privateKey, useGlobal);
    console.log(`Private key saved to ${scope} git config (nostr.privkey)`);
  }

  // If voucher provided, fund the new wallet
  if (voucherArg) {
    console.log('\nProcessing voucher...');

    try {
      const voucher = parseVoucher(voucherArg);
      console.log(`Chain: ${voucher.chain}`);
      console.log(`Voucher amount: ${voucher.amount.toLocaleString()} sats`);

      // Calculate amounts
      const userAmount = Math.min(INIT_AMOUNT, voucher.amount - MIN_FEE);
      const changeAmount = voucher.amount - userAmount - MIN_FEE;

      if (userAmount <= 0) {
        throw new Error(`Voucher amount too low. Need at least ${INIT_AMOUNT + MIN_FEE} sats.`);
      }

      console.log(`\nTransaction plan:`);
      console.log(`  Input:  ${voucher.amount.toLocaleString()} sats (from voucher)`);
      console.log(`  Output: ${userAmount.toLocaleString()} sats (to you)`);
      if (changeAmount > 0) {
        console.log(`  Change: ${changeAmount.toLocaleString()} sats (back to voucher)`);
      }
      console.log(`  Fee:    ${MIN_FEE.toLocaleString()} sats`);

      if (dryRun) {
        console.log('\n--dry-run: Transaction not broadcast.');
        process.exit(0);
      }

      // Build transaction
      const { buildTx } = await import('btctx');
      const voucherPubkey = getPubkey(voucher.privateKey);

      const outputs = [{ pubkey: publicKey, amount: userAmount }];

      if (changeAmount > 0) {
        outputs.push({ pubkey: voucherPubkey, amount: changeAmount });
      }

      console.log('\nBuilding transaction...');
      const { hex, txid } = await buildTx({
        privateKey: voucher.privateKey,
        publicKey: voucherPubkey,
        txid: voucher.txid,
        vout: voucher.vout,
        inputAmount: voucher.amount,
        outputs,
      });

      // Broadcast
      console.log('Broadcasting transaction...');
      const sendtx = (await import('sendtx')).default;
      const broadcastTxid = await sendtx(hex, voucher.chain);
      console.log(`Transaction broadcast: ${broadcastTxid}`);
      console.log(`Explorer: https://mempool.space/testnet4/tx/${broadcastTxid}`);

      // Create TXO file
      const txoDir = '.well-known/txo';
      const txoFile = path.join(txoDir, 'txo.json');

      fs.mkdirSync(txoDir, { recursive: true });

      const txoUri = `txo:${voucher.chain}:${broadcastTxid}:0?amount=${userAmount}&pubkey=${publicKey}`;

      let txoData = [];
      if (fs.existsSync(txoFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(txoFile, 'utf8'));
          if (Array.isArray(parsed)) txoData = parsed;
        } catch {
          // Unreadable file — start fresh rather than fail the funding
        }
      }
      txoData.push(txoUri);

      fs.writeFileSync(txoFile, JSON.stringify(txoData, null, 2));
      console.log(`\nTXO file ${txoData.length > 1 ? 'updated' : 'created'}: ${txoFile}`);

      // Set network
      gitConfig('gitmark.network', voucher.chain, useGlobal);

      // Update voucher with change output
      if (changeAmount > 0) {
        const newVoucher = createVoucher({
          chain: voucher.chain,
          txid: broadcastTxid,
          vout: 1,
          privateKey: voucher.privateKey,
          amount: changeAmount,
        });

        if (voucherFile) {
          saveVoucher(newVoucher, voucherFile);
          console.log(`Voucher file updated: ${voucherFile}`);
        } else {
          console.log(`\n--- New voucher (save this!) ---`);
          console.log(newVoucher);
        }
      } else if (voucherFile) {
        console.log(`\nWarning: Voucher exhausted (no change).`);
      }

      console.log('\n=== Agent funded successfully! ===');

    } catch (error) {
      console.error(`\nError processing voucher: ${error.message}`);
      console.log('\nKey was saved. You can fund manually later.');
      process.exit(1);
    }
  } else {
    console.log('\nNo voucher provided. Key saved but wallet not funded.');
    console.log('To fund, run again with a voucher:');
    console.log('  npx fund-agent ~/.gitmark/faucet.txt');
  }
}

main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
