import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { nip19 } from 'nostr-tools'

const CONFIG_DIR = join(homedir(), '.agent-chat')
const CONTACTS_FILE = join(CONFIG_DIR, 'contacts.json')

export function getContacts() {
  mkdirSync(CONFIG_DIR, { recursive: true })
  if (!existsSync(CONTACTS_FILE)) return []
  return JSON.parse(readFileSync(CONTACTS_FILE, 'utf8'))
}

export function addContact(npubOrHex, name) {
  let pubkey = npubOrHex
  if (npubOrHex.startsWith('npub')) {
    const decoded = nip19.decode(npubOrHex)
    pubkey = decoded.data
  }

  const contacts = getContacts()
  if (contacts.find(c => c.pubkey === pubkey)) {
    return { error: 'Contact already exists' }
  }

  const contact = {
    pubkey,
    npub: nip19.npubEncode(pubkey),
    name: name || pubkey.slice(0, 8),
    addedAt: Date.now(),
  }

  contacts.push(contact)
  saveContacts(contacts)
  return contact
}

export function saveContacts(contacts) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2))
}
