import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from './config.js'

const CONFIG_DIR = DATA_DIR
const MESSAGES_FILE = join(CONFIG_DIR, 'messages.json')

function load() {
  if (!existsSync(MESSAGES_FILE)) return {}
  return JSON.parse(readFileSync(MESSAGES_FILE, 'utf8'))
}

function save(data) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2))
}

export function getMessages(contactPubkey) {
  const all = load()
  return all[contactPubkey] || []
}

export function saveMessage(contactPubkey, msg) {
  const all = load()
  if (!all[contactPubkey]) all[contactPubkey] = []

  // Deduplicate by id
  if (!all[contactPubkey].find(m => m.id === msg.id)) {
    all[contactPubkey].push(msg)
    all[contactPubkey].sort((a, b) => a.created_at - b.created_at)
    save(all)
  }
}

export function mergeMessages(contactPubkey, msgs) {
  for (const msg of msgs) saveMessage(contactPubkey, msg)
}
