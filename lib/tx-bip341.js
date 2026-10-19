// Taproot key-path spends signed BIP341 (SIGHASH_DEFAULT) for the Core-signed chains: several inputs at one
// raw-key taproot address, any number of raw-key taproot outputs. The same shape as buildUnifiedTx in tx.js.
// Signing goes through @cmdcode/tapscript, as btctx does for one input.
import { Signer, Tx } from '@cmdcode/tapscript';
import { createHash } from 'crypto';

const isHex64 = (s) => typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s);

/**
 * @param {{privateKey: string, publicKey: string, inputs: {txid: string, vout: number, amount: number}[], outputs: {pubkey: string, amount: number}[]}} options
 * @returns {Promise<{hex: string, txid: string, txdata: object}>}
 */
export async function buildTaprootTx({ privateKey, publicKey, inputs, outputs }) {
  if (!isHex64(privateKey)) throw new Error('Invalid privateKey: expected 64-char hex string');
  if (!isHex64(publicKey)) throw new Error('Invalid publicKey: expected 64-char hex string');
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('Invalid inputs: expected non-empty array');
  if (!Array.isArray(outputs) || outputs.length === 0) throw new Error('Invalid outputs: expected non-empty array');
  for (const i of inputs) {
    if (!isHex64(i.txid)) throw new Error('Invalid txid: expected 64-char hex string');
    if (!Number.isInteger(i.vout) || i.vout < 0) throw new Error('Invalid vout: expected non-negative integer');
    if (!Number.isInteger(i.amount) || i.amount <= 0) throw new Error('Invalid input amount: expected positive integer');
  }
  const inTotal = inputs.reduce((a, i) => a + i.amount, 0);
  const outTotal = outputs.reduce((a, o) => {
    if (!isHex64(o.pubkey)) throw new Error('Invalid output pubkey: expected 64-char hex string');
    if (!Number.isInteger(o.amount) || o.amount <= 0) throw new Error('Invalid output amount: expected positive integer');
    return a + o.amount;
  }, 0);
  if (outTotal > inTotal) throw new Error(`Outputs (${outTotal}) exceed input (${inTotal})`);

  const txdata = Tx.create({
    vin: inputs.map((i) => ({ txid: i.txid, vout: i.vout, prevout: { value: i.amount, scriptPubKey: ['OP_1', publicKey] } })),
    vout: outputs.map((o) => ({ value: o.amount, scriptPubKey: ['OP_1', o.pubkey] })),
  });
  for (let i = 0; i < inputs.length; i++) {
    txdata.vin[i].witness = [Signer.taproot.sign(privateKey, txdata, i)];
  }
  for (let i = 0; i < inputs.length; i++) await Signer.taproot.verify(txdata, i, { throws: true });
  const encoded = Tx.encode(txdata);
  const hex = typeof encoded === 'string' ? encoded : encoded.hex;
  // the txid is sha256d of the serialization without witnesses, byte-reversed
  const strippedEnc = Tx.encode(txdata, true);
  const stripped = typeof strippedEnc === 'string' ? strippedEnc : strippedEnc.hex;
  const h = createHash('sha256').update(createHash('sha256').update(Buffer.from(stripped, 'hex')).digest()).digest();
  return { hex, txid: Buffer.from(h).reverse().toString('hex'), txdata };
}
