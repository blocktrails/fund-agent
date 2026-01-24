/**
 * fund-agent - Initialize git config nostr.privkey with funds from a voucher
 * @module fund-agent
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { getPublicKey } from '@noble/secp256k1';
import crypto from 'crypto';

export const INIT_AMOUNT = 1000000;
export const MIN_FEE = 1000;
export const DEFAULT_FAUCET = path.join(os.homedir(), '.gitmark', 'faucet.txt');

/**
 * Get x-only public key from private key
 * @param {string} privkey - 64-char hex private key
 * @returns {string} 64-char hex public key
 */
export function getPubkey(privkey) {
  const compressed = getPublicKey(privkey, true);
  return Buffer.from(compressed.slice(1)).toString('hex');
}

/**
 * Generate a random private key
 * @returns {string} 64-char hex private key
 */
export function generatePrivateKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a new keypair
 * @returns {{privateKey: string, publicKey: string}}
 */
export function generateKeypair() {
  const privateKey = generatePrivateKey();
  const publicKey = getPubkey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Get or set git config value
 * @param {string} key - Config key
 * @param {string|null} value - Value to set (null to get)
 * @param {boolean} global - Use global config
 * @returns {string|null}
 */
export function gitConfig(key, value = null, global = false) {
  const scope = global ? '--global' : '--local';
  try {
    if (value === null) {
      return execSync(`git config ${scope} ${key}`, { encoding: 'utf8' }).trim();
    } else {
      execSync(`git config ${scope} ${key} "${value}"`);
      return value;
    }
  } catch {
    return null;
  }
}

/**
 * Check if current directory is a git repository
 * @returns {boolean}
 */
export function isGitRepo() {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a TXO voucher URI
 * @param {string} uri - Voucher URI
 * @returns {{chain: string, txid: string, vout: number, privateKey: string, amount: number}}
 */
export function parseVoucher(uri) {
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

/**
 * Create a TXO voucher URI
 * @param {{chain: string, txid: string, vout: number, privateKey: string, amount: number}} options
 * @returns {string}
 */
export function createVoucher({ chain, txid, vout, privateKey, amount }) {
  return `txo:${chain}:${txid}:${vout}?amount=${amount}&key=${privateKey}`;
}

/**
 * Create a TXO URI (without private key)
 * @param {{chain: string, txid: string, vout: number, pubkey: string, amount: number}} options
 * @returns {string}
 */
export function createTxo({ chain, txid, vout, pubkey, amount }) {
  return `txo:${chain}:${txid}:${vout}?amount=${amount}&pubkey=${pubkey}`;
}

/**
 * Load voucher from file
 * @param {string} filePath
 * @returns {string|null}
 */
export function loadVoucher(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Save voucher to file
 * @param {string} uri
 * @param {string} filePath
 */
export function saveVoucher(uri, filePath) {
  fs.writeFileSync(filePath, uri + '\n');
}

/**
 * Fund an agent wallet from a voucher
 * @param {Object} options
 * @param {string} options.voucher - Voucher URI or file path
 * @param {boolean} options.global - Use global git config
 * @param {boolean} options.force - Overwrite existing key
 * @returns {Promise<{privateKey: string, publicKey: string, txid: string, amount: number}>}
 */
export async function fundAgent(options = {}) {
  const { voucher, global: useGlobal = false, force = false } = options;

  // Check for existing key
  const existingKey = gitConfig('nostr.privkey') || gitConfig('nostr.privkey', null, true);
  if (existingKey && !force) {
    return {
      privateKey: existingKey,
      publicKey: getPubkey(existingKey),
      existing: true,
    };
  }

  // Generate new keypair
  const { privateKey, publicKey } = generateKeypair();

  // Save to git config
  gitConfig('nostr.privkey', privateKey, useGlobal);

  // If no voucher, return unfunded
  if (!voucher) {
    return { privateKey, publicKey, funded: false };
  }

  // Load voucher
  let voucherUri = voucher;
  let voucherFile = null;

  if (!voucher.startsWith('txo:') && !voucher.startsWith('urn:voucher:')) {
    if (fs.existsSync(voucher)) {
      voucherFile = voucher;
      voucherUri = loadVoucher(voucher);
    } else {
      throw new Error(`Voucher file not found: ${voucher}`);
    }
  }

  const parsed = parseVoucher(voucherUri);

  // Calculate amounts
  const userAmount = Math.min(INIT_AMOUNT, parsed.amount - MIN_FEE);
  const changeAmount = parsed.amount - userAmount - MIN_FEE;

  if (userAmount <= 0) {
    throw new Error(`Voucher amount too low. Need at least ${INIT_AMOUNT + MIN_FEE} sats.`);
  }

  // Build transaction
  const { buildTx } = await import('btctx');
  const voucherPubkey = getPubkey(parsed.privateKey);

  const outputs = [{ pubkey: publicKey, amount: userAmount }];
  if (changeAmount > 0) {
    outputs.push({ pubkey: voucherPubkey, amount: changeAmount });
  }

  const { hex } = await buildTx({
    privateKey: parsed.privateKey,
    publicKey: voucherPubkey,
    txid: parsed.txid,
    vout: parsed.vout,
    inputAmount: parsed.amount,
    outputs,
  });

  // Broadcast
  const sendtx = (await import('sendtx')).default;
  const txid = await sendtx(hex, parsed.chain);

  // Create TXO file
  const txoDir = '.well-known/txo';
  fs.mkdirSync(txoDir, { recursive: true });

  const txoUri = createTxo({
    chain: parsed.chain,
    txid,
    vout: 0,
    pubkey: publicKey,
    amount: userAmount,
  });

  fs.writeFileSync(path.join(txoDir, 'txo.json'), JSON.stringify([txoUri], null, 2));

  // Update voucher file with change
  if (changeAmount > 0 && voucherFile) {
    const newVoucher = createVoucher({
      chain: parsed.chain,
      txid,
      vout: 1,
      privateKey: parsed.privateKey,
      amount: changeAmount,
    });
    saveVoucher(newVoucher, voucherFile);
  }

  return {
    privateKey,
    publicKey,
    txid,
    amount: userAmount,
    funded: true,
  };
}

export default fundAgent;
