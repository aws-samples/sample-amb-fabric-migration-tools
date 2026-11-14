# Signing a re-broadcast config bundle: instructions for one member

> Sample code, not an official AWS migration tool. See the [disclaimer](../../README.md#disclaimer).

You have been sent a **bundle**: a directory holding every channel config update that the migration will replay. Your organization
must sign the updates that its signature is needed for. You sign on your own machine, with your own admin key. **The key never
leaves that machine.** You send back only the signature files.

## What you need
- Node.js 22 or later.
- The `fabric-rebroadcast` package (the `rebroadcast/` directory of this repository): run `npm ci && npm run build` once.
- `configtxlator` from Fabric 2.5 on your `PATH` (part of the Fabric binaries). It decodes each update so you can see what it changes.
- Your organization's **admin** certificate and private key: the identity that signs channel config for your org.
- Your MSP ID. It is printed in the bundle's list of signers.

## 1. Check the bundle you received
```bash
shasum -a 256 -c bundle.tgz.sha256  # with the digest the operator sent you by a separate channel (email, chat): it must say OK
tar xzf bundle.tgz
amb-migrate sign-config verify <bundle> --configtxlator "$(command -v configtxlator)"
```
`verify` re-applies every update to the config before it and checks the result is the config the bundle says comes after it.
It lists every update, who must sign it, and the signatures present so far. Until every member has signed it ends with
`incomplete: … lack signatures` and exit code 10: that is expected. Any other error (an update that does not produce the
recorded result, a hash mismatch) means the bundle is not the one the operator made: stop and contact the operator.

## 2. Review, then sign
```bash
amb-migrate sign-config sign <bundle> --msp <YOUR_MSP_ID> --cert <admin-cert.pem> --key <admin-key.pem>
```
Without `--yes` nothing is written. For each update you must sign, it prints what the update changes. This is decoded from
the update bytes themselves, not from a description the operator wrote. Read it. You would expect: an organization added
(one that was added on the source network too), anchor peers, policies, capabilities. Only sign if every change matches what
happened on the source channel. When it does:
```bash
amb-migrate sign-config sign <bundle> --msp <YOUR_MSP_ID> --cert <admin-cert.pem> --key <admin-key.pem> --yes
```
The signature files are written to `<bundle>/signatures/<update>.<YOUR_MSP_ID>.json`. Each one holds the signature and your
**public** certificate, nothing else.

## 3. Send back
Send only your `signatures/*.<YOUR_MSP_ID>.json` files to the operator. Do **not** send your key or the whole bundle.

## For the operator: sending the bundle
```bash
tar czf bundle.tgz bundle && shasum -a 256 bundle.tgz > bundle.tgz.sha256
```
Send `bundle.tgz` and, by a different channel, the digest line. Collect the returned files with
`sign-config import <bundle> <files or dirs…>`, then check with `sign-config verify <bundle>`.

## What a signature lets the operator do
Each signature is over the exact bytes of one update. The operator cannot reuse it for another update or another channel: the
tool refuses it, and so does the destination orderer. The update can only take effect while the channel's config is the one
it was computed against.
