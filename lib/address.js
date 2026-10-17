// Raw-key taproot addresses: bech32m (BIP 350) of OP_1 <x-only pubkey>.
// Vendored in part from bitcoin-blake/blaketest bitcoin.js.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function createChecksum(hrp, data) {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ BECH32M_CONST;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error('invalid padding');
  return out;
}

/** bech32m address for a 32-byte x-only pubkey (hex), hrp 'tb' or 'bc'. */
export function taprootAddress(pubkeyHex, hrp) {
  if (!/^[0-9a-fA-F]{64}$/.test(pubkeyHex)) throw new Error('Invalid pubkey: expected 64-char hex string');
  if (hrp !== 'tb' && hrp !== 'bc') throw new Error(`Unknown hrp "${hrp}"`);
  const data = [1, ...convertBits(Buffer.from(pubkeyHex, 'hex'), 8, 5, true)];
  const combined = [...data, ...createChecksum(hrp, data)];
  return hrp + '1' + combined.map((d) => CHARSET[d]).join('');
}

/** The x-only pubkey (hex) behind a raw taproot address, or an error. */
export function decodeTaprootAddress(address) {
  const lower = address.toLowerCase();
  if (lower !== address && address.toUpperCase() !== address) throw new Error('mixed-case address');
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) throw new Error('malformed address');
  const hrp = lower.slice(0, pos);
  const data = [...lower.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1)) throw new Error('bad character');
  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) throw new Error('bad checksum');
  if (data[0] !== 1) throw new Error('not a witness v1 address');
  const prog = convertBits(data.slice(1, -6), 5, 8, false);
  if (prog.length !== 32) throw new Error('not a 32-byte program');
  return { hrp, pubkey: Buffer.from(prog).toString('hex') };
}
