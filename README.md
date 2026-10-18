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

### Setting up, once

```bash
npx fund-agent init
```

This writes a new voucher key to `~/.gitmark/faucet.txt` and prints an address. Send coins there
(default chain `txbt4`; `--chain xbt` or any id from the table below for another). From then on,
in any repo:

```bash
npx fund-agent
```

The first run after the coins arrive finds them through the chain's explorer and fills in the
outpoint; every run pays 10,000 sats to a fresh agent key and writes the change back to the file.
`npx fund-agent status` shows the address, the balance and how many agents it still funds.
In a funded repo, `npx fund-agent balance` shows what the agent's own key holds, and after `git mark`
the trail's current coin too.

If someone hands you a voucher string instead, store it with `npx fund-agent init "txo:…"`.
`FUND_AGENT_FAUCET=<path>` moves the file.

### CLI

```bash
# Initialize from default faucet (~/.gitmark/faucet.txt)
npx fund-agent

# Set up the voucher file: new key and an address to send coins to
npx fund-agent init
npx fund-agent init --chain xbt

# Store a voucher string in the voucher file
npx fund-agent init "txo:txbt4:abc123:0?amount=5000000&key=deadbeef..."

# Address, balance, agents left
npx fund-agent status

# What this repo's agent key holds (chain from git config gitmark.network, or --chain)
npx fund-agent balance

# Initialize from voucher file
npx fund-agent /path/to/voucher.txt

# Initialize from voucher URI
npx fund-agent "txo:tbtc4:abc123:0?amount=5000000&key=deadbeef..."

# A key already in git config (from npm init agent) is funded as is;
# --force replaces it with a new one
npx fund-agent

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

### `createFaucet({ chain, privateKey })`

A voucher key waiting for coins: `{ uri, chain, privateKey, publicKey, address, funded: false }`.
The uri form is `txo:<chain>?key=<privkey>`.

### `parseFaucet(uri)`

Parses either form. A funded voucher comes back as from `parseVoucher` plus `publicKey`, `address`
and `funded: true`.

### `refreshVoucher({ uri, file }, { fetch })`

For a waiting voucher, asks the chain's explorer for UTXOs at its address, takes the largest
(confirmed first), rewrites the file with the full voucher and returns `{ voucher, utxos }`.

### `balanceOf(chain, pubkey, { fetch })`
Returns `{ chain, address, utxos, confirmed, pending, total }` for a key: its coins from the chain's explorer, confirmed first.

### `trailTxo()`, `parseTxo(uri)`, `lookupOutput(chain, { txid, vout }, { fetch })`
The trail coin git mark keeps in git config `gitmark.txo`, the plain `txo:` parser it needs, and one output looked up
on the explorer: `{ address, amount, confirmed, spent }`.

### `addressOf(chain, pubkey)`, `lookupUtxos(chain, address)`, `agentsFrom(sats)`

Raw-key taproot address for a chain, the explorer UTXO lookup, and how many agents an amount funds.

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

| id | chain | explorer API, broadcast and links | signing |
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

## License

MIT
