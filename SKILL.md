---
name: fund-agent
description: Initialize git config nostr.privkey with funds from a voucher.
version: 1.0.0
author: melvincarvalho
uses: [txo, faucet, pay]
---

# Fund Agent

Initialize or fund the agent's wallet by setting up `git config nostr.privkey` and transferring funds from a TXO voucher.

## When to Use

Invoke with `/fund-agent` when you need to:
- Initialize a new agent with a funded wallet
- Fund an existing agent from a voucher
- Set up nostr.privkey in git config with testnet4 funds

## Prerequisites

Ensure these npm packages are available:
- `btctx` - Transaction building
- `sendtx` - Transaction broadcasting
- `noskey` - Key generation/display

## Instructions

### 1. Check for Existing Key

```bash
# Check if key already exists
git config nostr.privkey
```

If a key exists, display it with:
```bash
npx noskey -p $(git config nostr.privkey)
```

### 2. Generate New Key (if needed)

```bash
# Generate and save new keypair
npm init agent@latest
```

Or manually:
```bash
# Generate keypair
npx noskey > /tmp/keys.txt
# Extract and save privkey
PRIVKEY=$(grep privkey /tmp/keys.txt | awk '{print $2}')
git config --global nostr.privkey "$PRIVKEY"
```

### 3. Fund from Voucher

If a voucher URI is provided, use it to fund the wallet:

**Voucher format:** `txo:<chain>:<txid>:<vout>?amount=<sats>&key=<privkey>`

```bash
# Parse voucher and build funding transaction
# See /txo skill for parsing
# See /pay skill for transaction building
```

### 4. Create TXO File

After funding, create `.well-known/txo/txo.json`:

```bash
mkdir -p .well-known/txo
```

Write the TXO URI to the file:
```json
["txo:tbtc4:<txid>:0?amount=<sats>&pubkey=<pubkey>"]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `[voucher]` | TXO voucher URI or path to voucher file |
| `--global` | Store key in global git config |
| `--force` | Overwrite existing key |

## Examples

**Input:** `/fund-agent`

Generates a new keypair and saves to git config. No funding.

**Input:** `/fund-agent txo:tbtc4:abc...def:0?amount=5000000&key=123...abc`

Generates keypair, funds from voucher, creates TXO file.

**Input:** `/fund-agent ~/.gitmark/faucet.txt`

Reads voucher from file, funds wallet, updates file with change.

## Workflow

1. Check for existing `nostr.privkey` in git config
2. If none (or `--force`), generate new keypair
3. Save private key to git config
4. If voucher provided:
   - Parse voucher (see `/txo`)
   - Build transaction: voucher -> user wallet + change
   - Broadcast transaction
   - Create `.well-known/txo/txo.json`
   - Update voucher file with change (if file source)
5. Display public key and funding status

## Default Faucet

If no voucher is provided, check for default faucet at:
```
~/.gitmark/faucet.txt
```

## Transaction Details

- **INIT_AMOUNT:** 1,000,000 sats (0.01 BTC) to user
- **MIN_FEE:** 1,000 sats
- **Change:** Returns to voucher address

## Output

```
=== fund-agent ===

Generating new keypair...
Public key: <64-char hex pubkey>
Private key saved to global git config (nostr.privkey)

Processing voucher...
Chain: tbtc4
Voucher amount: 5000000 sats

Transaction plan:
  Input:  5000000 sats (from voucher)
  Output: 1000000 sats (to you)
  Change: 3999000 sats (back to voucher)
  Fee:    1000 sats

Building transaction...
Broadcasting transaction...
Transaction broadcast: <txid>

TXO file created: .well-known/txo/txo.json

=== Initialization complete! ===
```

## Security Notes

- Private keys are stored in git config (not in files)
- Never commit private keys to repositories
- Voucher private keys are temporary and should be rotated

## References

- [gitmark-test](https://github.com/solidpayorg/gitmark-test)
- [btctx](https://www.npmjs.com/package/btctx)
- [sendtx](https://www.npmjs.com/package/sendtx)
- [noskey](https://www.npmjs.com/package/noskey)
