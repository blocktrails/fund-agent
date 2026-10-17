# fund-agent

Initialize `git config nostr.privkey` with funds from a TXO voucher.

## Install

```bash
npm install -g fund-agent
```

Or use directly with npx:

```bash
npx fund-agent
```

## Usage

### CLI

```bash
# Initialize from default faucet (~/.gitmark/faucet.txt)
npx fund-agent

# Initialize from voucher file
npx fund-agent /path/to/voucher.txt

# Initialize from voucher URI
npx fund-agent "txo:tbtc4:abc123:0?amount=5000000&key=deadbeef..."

# Fund the existing key (no new key generated)
npx fund-agent --existing

# Generate key only (no funding)
npx fund-agent --no-fund

# Use global git config
npx fund-agent --global

# Dry run (show plan without broadcasting)
npx fund-agent --dry-run
```

The CLI is a thin layer over the library: `resolveVoucher`, `resolveKey`, `planFunding` and `fund` are
the steps, and `fundAgent` runs them in one call.

### Programmatic

```javascript
import { fundAgent, generateKeypair, parseVoucher } from 'fund-agent';

// Fund from voucher
const result = await fundAgent({
  voucher: '~/.gitmark/faucet.txt',
  global: true,
});

console.log(result.publicKey);  // Your new public key
console.log(result.txid);       // Funding transaction ID

// Generate keypair only
const { privateKey, publicKey } = generateKeypair();

// Parse a voucher URI
const voucher = parseVoucher('txo:tbtc4:abc:0?amount=1000000&key=xyz');
console.log(voucher.amount);  // 1000000
```

## API

### `fundAgent(options)`

Fund an agent wallet from a voucher.

Options:
- `voucher` - Voucher URI or file path
- `global` - Use global git config (default: false)
- `force` - Overwrite existing key (default: false)

Returns:
- `privateKey` - Generated private key
- `publicKey` - Derived public key
- `txid` - Funding transaction ID
- `amount` - Funded amount in satoshis
- `funded` - Whether funding was performed

### `generateKeypair()`

Generate a new secp256k1 keypair.

### `parseVoucher(uri)`

Parse a TXO voucher URI.

### `createVoucher(options)`

Create a TXO voucher URI.

### `gitConfig(key, value, global)`

Get or set git config values.

### `planFunding(voucher)`

The amounts a parsed voucher yields: `userAmount`, `changeAmount`, `fee`, and the `chain` entry.

### `explorerUrl(chain, txid)`

The explorer link for a transaction on that chain.

### `CHAINS`

The chain table: name, broadcast endpoint, explorer, and which sighash a spend needs.

## Voucher Format

```
txo:<chain>:<txid>:<vout>?amount=<sats>&key=<privkey>
```

Example:
```
txo:tbtc4:abc123def456:0?amount=5000000&key=0123456789abcdef...
```

## Files Created

- `git config nostr.privkey` - Your private key
- `.well-known/txo/txo.json` - Your TXO (spendable output)

## Chains

| id | chain | broadcast and explorer | signing |
|---|---|---|---|
| `tbtc4` | Bitcoin testnet4 (default) | mempool.space | BIP341 key path |
| `tbtc3` | Bitcoin testnet3 | mempool.space | BIP341 key path |
| `signet` | Bitcoin signet | mempool.space | BIP341 key path |
| `btc` | Bitcoin mainnet | mempool.space | BIP341 key path |
| `txbt4` | Bitcoin BLAKE2b testnet4 | mempool.guide | unified sighash (0x21), replay-protected |
| `xbt` | Bitcoin BLAKE2b mainnet | mempool.guide | unified sighash (0x21), replay-protected |

The SHA256d chains and the BLAKE2b chains live on different explorers, so the chain in the voucher
decides where the transaction is posted and where the explorer link points. A voucher on a BLAKE2b
chain is signed with the unified opt-in sighash from Knots (`lib/unified.js`, checked against the
166 Knots vectors in `test/unified_sighash.json`), so the spend is valid only on that chain.
`buildFundingTx` returns the signed hex without broadcasting, if you want to inspect it first.

## Related

- [gitmark](https://github.com/solidpayorg/gitmark-test) - Anchor git commits to Bitcoin
- [blocktrails](https://blocktrails.org) - State anchoring protocol
- [btctx](https://npmjs.com/package/btctx) - Transaction building
- [sendtx](https://npmjs.com/package/sendtx) - Transaction broadcasting

## License

MIT
