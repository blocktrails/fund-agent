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

# Generate key only (no funding)
npx fund-agent --no-fund

# Use global git config
npx fund-agent --global

# Dry run (show plan without broadcasting)
npx fund-agent --dry-run
```

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

## Networks

- `tbtc4` - Bitcoin Testnet4 (default)
- `btc` - Bitcoin Mainnet
- `signet` - Bitcoin Signet

## Related

- [gitmark](https://github.com/solidpayorg/gitmark-test) - Anchor git commits to Bitcoin
- [blocktrails](https://blocktrails.org) - State anchoring protocol
- [btctx](https://npmjs.com/package/btctx) - Transaction building
- [sendtx](https://npmjs.com/package/sendtx) - Transaction broadcasting

## License

MIT
