/**
 * fund-agent - Initialize git config nostr.privkey with funds from a voucher
 * @module fund-agent
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { getPublicKey } from '@noble/secp256k1';
import crypto from 'crypto';
import { taprootAddress } from './lib/address.js';

export const VERSION = createRequire(import.meta.url)('./package.json').version;
export const INIT_AMOUNT = 1000000;
export const MIN_FEE = 1000;
export const DEFAULT_FAUCET = process.env.FUND_AGENT_FAUCET || path.join(os.homedir(), '.gitmark', 'faucet.txt');

/**
 * Chains a voucher can name. `broadcast` is where the raw transaction is posted and `explorer`
 * where a txid can be seen; both are chain-specific, since mempool.space serves the SHA256d chains
 * and mempool.guide the BLAKE2b ones. `sighash` says how a key-path taproot spend is signed:
 * 'bip341' is what btctx produces; 'unified' (0x21) is the BLAKE2b chains' replay-protected
 * sighash, which this version cannot produce yet.
 */
export const CHAINS = {
  btc:    { name: 'Bitcoin mainnet',          network: 'mainnet', sighash: 'bip341',  hrp: 'bc', api: 'https://mempool.space/api',          broadcast: 'https://mempool.space/api/tx',          explorer: 'https://mempool.space/tx/' },
  tbtc3:  { name: 'Bitcoin testnet3',         network: 'testnet', sighash: 'bip341',  hrp: 'tb', api: 'https://mempool.space/testnet/api',  broadcast: 'https://mempool.space/testnet/api/tx',  explorer: 'https://mempool.space/testnet/tx/' },
  tbtc4:  { name: 'Bitcoin testnet4',         network: 'testnet', sighash: 'bip341',  hrp: 'tb', api: 'https://mempool.space/testnet4/api', broadcast: 'https://mempool.space/testnet4/api/tx', explorer: 'https://mempool.space/testnet4/tx/' },
  signet: { name: 'Bitcoin signet',           network: 'testnet', sighash: 'bip341',  hrp: 'tb', api: 'https://mempool.space/signet/api',   broadcast: 'https://mempool.space/signet/api/tx',   explorer: 'https://mempool.space/signet/tx/' },
  txbt4:  { name: 'Bitcoin BLAKE2b testnet4', network: 'testnet', sighash: 'unified', hrp: 'tb', api: 'https://mempool.guide/testnet4/api', broadcast: 'https://mempool.guide/testnet4/api/tx', explorer: 'https://mempool.guide/testnet4/tx/' },
  xbt:    { name: 'Bitcoin BLAKE2b mainnet',  network: 'mainnet', sighash: 'unified', hrp: 'bc', api: 'https://mempool.guide/api',          broadcast: 'https://mempool.guide/api/tx',          explorer: 'https://mempool.guide/tx/' },
};
export const DEFAULT_CHAIN = 'txbt4';
// Chains accepted in a voucher's chain segment: the keys of CHAINS.
export const KNOWN_CHAINS = new Set(Object.keys(CHAINS));

/**
 * Look a chain up, or throw naming the ones known
 * @param {string} chain
 */
export function chainInfo(chain) {
  const c = CHAINS[chain];
  if (!c) throw new Error(`Unknown chain "${chain}". Known: ${Object.keys(CHAINS).join(', ')}`);
  return c;
}

/**
 * Explorer URL for a transaction on a chain
 * @param {string} chain
 * @param {string} txid
 * @returns {string}
 */
export function explorerUrl(chain, txid) {
  return chainInfo(chain).explorer + txid;
}

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
 * Get or set a git config value. Arguments go to git directly, never through a shell.
 * @param {string} key - Config key
 * @param {string|null} value - Value to set (null to get)
 * @param {boolean} global - Use global config
 * @returns {string|null}
 */
export function gitConfig(key, value = null, global = false) {
  const scope = global ? '--global' : '--local';
  try {
    if (value === null) {
      return execFileSync('git', ['config', scope, key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    }
    execFileSync('git', ['config', scope, '--', key, value], { stdio: 'ignore' });
    return value;
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
    execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
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
  let normalized = uri.trim();
  if (normalized.startsWith('urn:voucher:txo:')) {
    normalized = normalized.slice('urn:voucher:'.length);
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
      params[key] = decodeURIComponent(value ?? '');
    }
  }

  if (!chain || !txid || Number.isNaN(vout)) throw new Error('Invalid voucher: expected txo:<chain>:<txid>:<vout>');
  if (!KNOWN_CHAINS.has(chain)) throw new Error(`Invalid voucher: unknown chain "${chain}"`);
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error('Invalid voucher: txid must be 64 hex characters');
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
 * Raw-key taproot address of an x-only pubkey on a chain (tb1p… or bc1p…)
 * @param {string} chainId
 * @param {string} pubkey - 64-char hex x-only pubkey
 * @returns {string}
 */
export function addressOf(chainId, pubkey) {
  return taprootAddress(pubkey, chainInfo(chainId).hrp);
}

/**
 * A voucher that is waiting for coins: a key and a chain, no outpoint yet.
 * Written as txo:<chain>?key=<privkey>; send coins to its address and the
 * next run fills in the outpoint from the chain's explorer.
 * @param {{chain?: string, privateKey?: string}} [options]
 * @returns {{uri: string, chain: string, privateKey: string, publicKey: string, address: string, funded: false}}
 */
export function createFaucet({ chain = DEFAULT_CHAIN, privateKey = generatePrivateKey() } = {}) {
  chainInfo(chain);
  const publicKey = getPubkey(privateKey);
  return { uri: `txo:${chain}?key=${privateKey}`, chain, privateKey, publicKey, address: addressOf(chain, publicKey), funded: false };
}

/**
 * Parse either voucher form. A funded voucher parses as parseVoucher does,
 * plus publicKey, address and funded: true; the waiting form gives funded: false.
 * @param {string} uri
 */
export function parseFaucet(uri) {
  let u = uri.trim();
  if (u.startsWith('urn:voucher:')) u = u.slice('urn:voucher:'.length);
  const waiting = u.match(/^txo:([a-z0-9]+)\?key=([0-9a-fA-F]{64})$/);
  if (waiting) return createFaucet({ chain: waiting[1], privateKey: waiting[2] });
  const v = parseVoucher(u);
  const publicKey = getPubkey(v.privateKey);
  return { ...v, uri: createVoucher(v), publicKey, address: addressOf(v.chain, publicKey), funded: true };
}

/**
 * UTXOs at an address, from the chain's explorer API
 * @param {string} chainId
 * @param {string} address
 * @param {{fetch?: typeof fetch}} [options]
 * @returns {Promise<{txid: string, vout: number, value: number, confirmed: boolean}[]>}
 */
export async function lookupUtxos(chainId, address, { fetch: f = globalThis.fetch } = {}) {
  const url = `${chainInfo(chainId).api}/address/${address}/utxo`;
  const res = await f(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Explorer lookup failed: ${res.status} ${url}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`Explorer lookup failed: unexpected reply from ${url}`);
  return rows.map((r) => ({ txid: r.txid, vout: r.vout, value: Number(r.value), confirmed: !!(r.status && r.status.confirmed) }));
}

/**
 * Turn a waiting voucher into a funded one if coins have arrived: the largest
 * UTXO at its address (confirmed first) becomes the outpoint, and the file,
 * if any, is rewritten. A funded voucher is returned as is.
 * @param {{uri: string, file: string|null}} v
 * @param {{fetch?: typeof fetch}} [options]
 * @returns {Promise<{voucher: object, utxos: object[]}>}
 */
export async function refreshVoucher(v, options = {}) {
  const parsed = parseFaucet(v.uri);
  if (parsed.funded) return { voucher: parsed, utxos: [] };
  const utxos = await lookupUtxos(parsed.chain, parsed.address, options);
  const pick = [...utxos].sort((a, b) => (b.confirmed - a.confirmed) || (b.value - a.value))[0];
  if (!pick) return { voucher: parsed, utxos };
  const uri = createVoucher({ chain: parsed.chain, txid: pick.txid, vout: pick.vout, privateKey: parsed.privateKey, amount: pick.value });
  if (v.file) saveVoucher(uri, v.file);
  return { voucher: parseFaucet(uri), utxos };
}

/**
 * How many agents a voucher funds at INIT_AMOUNT each, plus a smaller last one
 * @param {number} amount - sats
 * @returns {{full: number, partial: boolean}}
 */
export function agentsFrom(amount) {
  const full = Math.floor(amount / (INIT_AMOUNT + MIN_FEE));
  const rest = amount - full * (INIT_AMOUNT + MIN_FEE);
  return { full, partial: rest > MIN_FEE };
}

/**
 * Resolve a voucher argument: a txo:/urn:voucher: URI, a file path, or nothing (the default faucet file)
 * @param {string|undefined} arg
 * @returns {{uri: string, file: string|null}|null} null when there is nothing to fund from
 */
export function resolveVoucher(arg) {
  if (arg) {
    if (arg.startsWith('txo:') || arg.startsWith('urn:voucher:')) return { uri: arg, file: null };
    if (!fs.existsSync(arg)) throw new Error(`Invalid voucher: must be a txo: URI or a path to a file (${arg})`);
    const uri = loadVoucher(arg);
    if (!uri) throw new Error(`Could not read a voucher from ${arg}`);
    return { uri, file: arg };
  }
  if (fs.existsSync(DEFAULT_FAUCET)) {
    const uri = loadVoucher(DEFAULT_FAUCET);
    if (uri) return { uri, file: DEFAULT_FAUCET };
  }
  return null;
}

/**
 * The funding plan for a voucher: what goes to the agent, what returns to the voucher, the fee
 * @param {{amount: number, chain: string}} voucher - parsed voucher
 * @returns {{chain: object, userAmount: number, changeAmount: number, fee: number}}
 */
export function planFunding(voucher) {
  const chain = chainInfo(voucher.chain);
  const fee = MIN_FEE;
  const userAmount = Math.min(INIT_AMOUNT, voucher.amount - fee);
  if (userAmount <= 0) throw new Error(`Voucher amount too low: ${voucher.amount} sats leaves nothing after the ${fee} sat fee.`);
  const changeAmount = voucher.amount - userAmount - fee;
  return { chain, userAmount, changeAmount, fee };
}

/**
 * Find the key to fund: the existing one, a fresh one, or a refusal to touch what is there
 * @param {{global?: boolean, existing?: boolean, force?: boolean}} options
 * @returns {{privateKey: string, publicKey: string, created: boolean, kept: boolean}}
 *   kept=true means a key exists and neither --existing nor --force was given, so nothing was done
 */
export function resolveKey({ global: useGlobal = false, existing = false, force = false } = {}) {
  const existingKey = gitConfig('nostr.privkey') || gitConfig('nostr.privkey', null, true);
  if (existingKey && existing) return { privateKey: existingKey, publicKey: getPubkey(existingKey), created: false, kept: false };
  if (existingKey && !force) return { privateKey: existingKey, publicKey: getPubkey(existingKey), created: false, kept: true };
  const { privateKey, publicKey } = generateKeypair();
  gitConfig('nostr.privkey', privateKey, useGlobal);
  return { privateKey, publicKey, created: true, kept: false };
}

/**
 * Post a signed transaction to the chain's explorer endpoint (mempool API: raw hex in, txid out)
 * @param {string} hex
 * @param {string} chainId
 * @param {{fetch?: typeof fetch}} [options]
 * @returns {Promise<string>} txid
 */
export async function broadcast(hex, chainId, { fetch: f = globalThis.fetch } = {}) {
  const chain = chainInfo(chainId);
  const res = await f(chain.broadcast, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: hex });
  const body = (await res.text()).trim();
  if (!res.ok) throw new Error(`Broadcast failed (${res.status} from ${chain.broadcast}): ${body}`);
  if (!/^[0-9a-f]{64}$/.test(body)) throw new Error(`Broadcast failed: unexpected reply from ${chain.broadcast}: ${body.slice(0, 200)}`);
  return body;
}

/**
 * Build and sign the funding transaction for a voucher, without broadcasting.
 * Output 0 pays the agent, output 1 (if any) is change back to the voucher key.
 * BIP341 chains sign through btctx; the BLAKE2b chains sign the unified
 * sighash (hash type 0x21) through lib/tx.js, so the spend cannot replay.
 * @param {{publicKey: string, voucher: object}} options
 * @returns {Promise<{hex: string, txid: string, chain: object, userAmount: number, changeAmount: number, sighash: string}>}
 */
export async function buildFundingTx({ publicKey, voucher }) {
  const { chain, userAmount, changeAmount } = planFunding(voucher);
  const voucherPubkey = getPubkey(voucher.privateKey);
  const outputs = [{ pubkey: publicKey, amount: userAmount }];
  if (changeAmount > 0) outputs.push({ pubkey: voucherPubkey, amount: changeAmount });
  const input = { privateKey: voucher.privateKey, publicKey: voucherPubkey, txid: voucher.txid, vout: voucher.vout, inputAmount: voucher.amount, outputs };

  let built;
  if (chain.sighash === 'unified') {
    const { buildUnifiedTx } = await import('./lib/tx.js');
    built = buildUnifiedTx(input);
  } else {
    const { buildTx } = await import('btctx');
    built = await buildTx({ ...input, network: chain.network });
  }
  return { hex: built.hex, txid: built.txid, chain, userAmount, changeAmount, sighash: chain.sighash };
}

/**
 * Fund an agent key from a voucher: sign, broadcast, record the TXO, keep the change
 * @param {Object} options
 * @param {string} options.publicKey - x-only pubkey of the agent being funded
 * @param {Object} options.voucher - parsed voucher (see parseVoucher)
 * @param {string|null} [options.voucherFile] - file the voucher came from, updated with the change
 * @param {boolean} [options.global] - write gitmark.network to the global git config
 * @returns {Promise<{txid: string, explorer: string, amount: number, txoFile: string, txoCount: number, newVoucher: string|null, address: string}>}
 */
export async function fund({ publicKey, voucher, voucherFile = null, global: useGlobal = false, fetch: f = globalThis.fetch }) {
  const { hex, userAmount, changeAmount } = await buildFundingTx({ publicKey, voucher });
  const chain = chainInfo(voucher.chain);

  const txid = await broadcast(hex, voucher.chain, { fetch: f });

  const txoDir = '.well-known/txo';
  const txoFile = path.join(txoDir, 'txo.json');
  fs.mkdirSync(txoDir, { recursive: true });
  let txoData = [];
  if (fs.existsSync(txoFile)) {
    try {
      const current = JSON.parse(fs.readFileSync(txoFile, 'utf8'));
      if (Array.isArray(current)) txoData = current;
    } catch {
      // Unreadable file: start fresh rather than fail the funding
    }
  }
  txoData.push(createTxo({ chain: voucher.chain, txid, vout: 0, pubkey: publicKey, amount: userAmount }));
  fs.writeFileSync(txoFile, JSON.stringify(txoData, null, 2));

  gitConfig('gitmark.network', voucher.chain, useGlobal);

  // Change becomes the next voucher. With no change the key stays in the file
  // in its waiting form, so the same address can be topped up and found again.
  let newVoucher = null;
  if (changeAmount > 0) {
    newVoucher = createVoucher({ chain: voucher.chain, txid, vout: 1, privateKey: voucher.privateKey, amount: changeAmount });
  }
  if (voucherFile) saveVoucher(newVoucher || createFaucet({ chain: voucher.chain, privateKey: voucher.privateKey }).uri, voucherFile);

  return { txid, explorer: explorerUrl(voucher.chain, txid), amount: userAmount, txoFile, txoCount: txoData.length, newVoucher, address: addressOf(voucher.chain, getPubkey(voucher.privateKey)) };
}

/**
 * Fund an agent wallet from a voucher: resolve the key, then fund it
 * @param {Object} options
 * @param {string} [options.voucher] - Voucher URI or file path (default: ~/.gitmark/faucet.txt)
 * @param {boolean} [options.global] - Use global git config
 * @param {boolean} [options.existing] - Fund the existing key instead of generating a new one
 * @param {boolean} [options.force] - Discard the existing key and generate a new one
 * @returns {Promise<{privateKey: string, publicKey: string, funded: boolean, existing?: boolean, txid?: string, explorer?: string, amount?: number}>}
 */
export async function fundAgent(options = {}) {
  const key = resolveKey(options);
  if (key.kept) return { privateKey: key.privateKey, publicKey: key.publicKey, existing: true, funded: false };

  const v = resolveVoucher(options.voucher);
  if (!v) return { privateKey: key.privateKey, publicKey: key.publicKey, funded: false };

  const voucher = parseVoucher(v.uri);
  const result = await fund({ publicKey: key.publicKey, voucher, voucherFile: v.file, global: options.global });
  return { privateKey: key.privateKey, publicKey: key.publicKey, funded: true, txid: result.txid, explorer: result.explorer, amount: result.amount };
}

export default fundAgent;
