import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { nip19 } from 'nostr-tools'
import { DATA_DIR } from './config.js'

const CONFIG_DIR = DATA_DIR
const CONTACTS_FILE = join(CONFIG_DIR, 'contacts.json')

export function getContacts() {
  mkdirSync(CONFIG_DIR, { recursive: true })
  if (!existsSync(CONTACTS_FILE)) return []
  const contacts = JSON.parse(readFileSync(CONTACTS_FILE, 'utf8'))
  // Migrate: ensure trustLevel exists on all contacts
  let dirty = false
  for (const c of contacts) {
    if (c.trustLevel === undefined) { c.trustLevel = 1; dirty = true }
  }
  if (dirty) saveContacts(contacts)
  return contacts
}

export function addContact(npubOrHex, name, trustLevel) {
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
    trustLevel: (trustLevel !== undefined) ? trustLevel : 1,  // 0=silent, 1=chat, 2=query, 3=exec
    addedAt: Date.now(),
  }

  contacts.push(contact)
  saveContacts(contacts)
  return contact
}

export function renameContact(pubkey, name) {
  const contacts = getContacts()
  const c = contacts.find(c => c.pubkey === pubkey)
  if (!c) return { error: 'Contact not found' }
  c.name = name
  saveContacts(contacts)
  return c
}

export function setTrustLevel(pubkey, level) {
  const lvl = parseInt(level, 10)
  if (isNaN(lvl) || lvl < 0 || lvl > 3) return { error: 'trustLevel must be 0-3' }
  const contacts = getContacts()
  const c = contacts.find(c => c.pubkey === pubkey)
  if (!c) return { error: 'Contact not found' }
  c.trustLevel = lvl
  saveContacts(contacts)
  return c
}

export function removeContact(pubkey) {
  const contacts = getContacts()
  const idx = contacts.findIndex(c => c.pubkey === pubkey)
  if (idx === -1) return { error: 'Contact not found' }
  contacts.splice(idx, 1)
  saveContacts(contacts)
  return { ok: true }
}

// ── Blocked list ──────────────────────────────────────────────────────────────
const BLOCKED_FILE = join(CONFIG_DIR, 'blocked.json')

export function getBlocked() {
  if (!existsSync(BLOCKED_FILE)) return []
  return JSON.parse(readFileSync(BLOCKED_FILE, 'utf8'))
}

export function isBlocked(pubkey) {
  return getBlocked().includes(pubkey)
}

export function blockContact(pubkey) {
  const list = getBlocked()
  if (!list.includes(pubkey)) {
    list.push(pubkey)
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(BLOCKED_FILE, JSON.stringify(list, null, 2))
  }
  // Also remove from contacts
  const contacts = getContacts()
  const idx = contacts.findIndex(c => c.pubkey === pubkey)
  if (idx !== -1) { contacts.splice(idx, 1); saveContacts(contacts) }
  return { ok: true }
}

export function unblockContact(pubkey) {
  const list = getBlocked().filter(p => p !== pubkey)
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(BLOCKED_FILE, JSON.stringify(list, null, 2))
  return { ok: true }
}

// ── Pending (stranger requests) ───────────────────────────────────────────────
const PENDING_FILE = join(CONFIG_DIR, 'pending.json')

export function getPending() {
  if (!existsSync(PENDING_FILE)) return []
  return JSON.parse(readFileSync(PENDING_FILE, 'utf8'))
}

export function addPendingMessage(pubkey, msg) {
  const list = getPending()
  // Only keep the first message per pubkey
  if (list.find(p => p.pubkey === pubkey)) return false
  list.push({ pubkey, msg, receivedAt: Date.now() })
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2))
  return true
}

export function removePending(pubkey) {
  const list = getPending().filter(p => p.pubkey !== pubkey)
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2))
}

export function saveContacts(contacts) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2))
}
