import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from './config.js'

const CONFIG_DIR = DATA_DIR
const IDENTITY_FILE = join(CONFIG_DIR, 'identity.json')

export function getIdentity() {
  mkdirSync(CONFIG_DIR, { recursive: true })

  if (existsSync(IDENTITY_FILE)) {
    const data = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'))
    return {
      privkey: Uint8Array.from(Buffer.from(data.privkey, 'hex')),
      pubkey: data.pubkey,
      npub: data.npub,
    }
  }

  // Generate new identity
  const privkey = generateSecretKey()
  const pubkey = getPublicKey(privkey)
  const npub = nip19.npubEncode(pubkey)

  const data = {
    privkey: Buffer.from(privkey).toString('hex'),
    pubkey,
    npub,
  }

  writeFileSync(IDENTITY_FILE, JSON.stringify(data, null, 2))
  console.log('Generated new identity:', npub)

  return { privkey, pubkey, npub }
}
