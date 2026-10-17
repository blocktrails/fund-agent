---
name: fund-agent
description: Give this repo's agent key its first coins from the voucher file, one line, after npm init agent.
version: 1.0.0
author: melvincarvalho
uses: [txo, faucet]
---

# Fund Agent

`npx fund-agent` pays 10,000 sats to the agent key in this repo's git config (`nostr.privkey`) from the
voucher in `~/.gitmark/faucet.txt`, records the coin in `.well-known/txo/txo.json`, and writes the change
back to the voucher file so the next repo is the same one line.

## When to Use

- Right after `npm init agent`, to give the new key coins.
- Any time a repo's agent key has no coin in `.well-known/txo/txo.json`.
- To set up or inspect the voucher file: `init`, `status`.

## The one line

```bash
npx fund-agent
```

What it does, in order:

1. Reads the voucher file (`~/.gitmark/faucet.txt`, or `FUND_AGENT_FAUCET`). If the file holds a key that is
   still waiting for coins, it asks the chain's explorer for UTXOs at that key's address and fills in the outpoint.
2. Uses the key already in `git config nostr.privkey`, or makes one if there is none. `--force` replaces it.
3. Signs one transaction: 10,000 sats to the agent, 1,000 sats fee, the rest back to the voucher key.
   Core chains sign BIP341; the BLAKE2b chains (`txbt4`, `xbt`) sign the unified sighash, so the spend cannot replay.
4. Posts it to the chain's explorer endpoint, appends the coin to `.well-known/txo/txo.json`, sets
   `git config gitmark.network`, and rewrites the voucher file with the change.

Stops before writing anything if the voucher file is missing, empty, or has no coins yet; in that case it prints
the address to send coins to.

## Setting up the voucher file, once

```bash
npx fund-agent init              # new key in ~/.gitmark/faucet.txt, prints an address; send coins there
npx fund-agent init --chain xbt  # same, for another chain (default txbt4)
npx fund-agent init "txo:…"      # store a voucher string someone gave you
npx fund-agent status            # chain, address, balance, how many agents it still funds
```

On this machine the txbt4 faucet (`/faucet` skill) can pay the printed address: `faucet pay <address> 0.01`.

## Arguments

| Argument | Description |
|----------|-------------|
| `[voucher]` | A `txo:` voucher URI or a path to a file holding one, instead of the default file |
| `init [voucher]` | Set up the voucher file (see above) |
| `status` | Show what the voucher file holds |
| `--chain <id>` | Chain for a new voucher key (`init` only) |
| `--global` | Store the agent key in global git config |
| `--force` | Replace the existing agent key with a new one (the old key is lost) |
| `--no-fund` | Make the key only, do not look for a voucher |
| `--dry-run` | Print the plan, do not broadcast |

Chains: `btc`, `tbtc3`, `tbtc4`, `signet` (mempool.space), `txbt4`, `xbt` (mempool.guide, unified sighash).

## Voucher forms

```
txo:<chain>:<txid>:<vout>?amount=<sats>&key=<privkey>   a coin and the key that spends it
txo:<chain>?key=<privkey>                               a key waiting for coins at its address
```

`urn:voucher:` may prefix either. Whoever holds the string holds the coins: never print it, never commit it.

## Output

```
=== fund-agent v0.0.5 ===

Using default faucet: /home/you/.gitmark/faucet.txt
Funding the key in git config (nostr.privkey).
Public key: <64-char hex>

Processing voucher...
Chain: txbt4 (Bitcoin BLAKE2b testnet4)
Voucher amount: 1,000,000 sats

Transaction plan:
  Input:  1,000,000 sats (from voucher)
  Output: 10,000 sats (to you)
  Change: 989,000 sats (back to voucher)
  Fee:    1,000 sats

Building and broadcasting transaction...
Transaction broadcast: <txid>
Explorer: https://mempool.guide/testnet4/tx/<txid>

TXO file created: .well-known/txo/txo.json
Voucher file updated: /home/you/.gitmark/faucet.txt

=== Agent funded successfully! ===
```

## Library

`import { fundAgent, buildFundingTx, broadcast, createFaucet, refreshVoucher, CHAINS } from 'fund-agent'`.
`buildFundingTx` returns the signed hex without sending it. See README.md.

## Security Notes

- The agent key lives in git config, never in a tracked file.
- The voucher file is mode 600 and holds a private key; keep it out of repos and logs.
- One voucher, one spend at a time: two funding runs at once would race on the same coin.

## References

- [fund-agent](https://github.com/blocktrails/fund-agent)
- [bitcoin-kernel utxo page](https://bitcoin-kernel.com/utxo/), which opens any `txo:` coin
- [create-agent](https://init-agent.com/SKILL.md), which makes the key this tool funds
