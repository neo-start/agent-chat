// Central config — reads from env vars / .env
// All other modules import from here instead of hardcoding.
import { homedir } from 'os'
import { join } from 'path'

export const PORT = parseInt(process.env.AGENT_CHAT_PORT || '3737', 10)

export const DATA_DIR = process.env.AGENT_CHAT_DATA_DIR
  ? process.env.AGENT_CHAT_DATA_DIR
  : join(homedir(), '.agent-chat')

const DEFAULT_RELAYS = 'wss://nos.lol,wss://relay.primal.net,wss://relay.damus.io'
export const RELAY_URLS = (process.env.AGENT_CHAT_RELAYS || DEFAULT_RELAYS)
  .split(',').map(r => r.trim()).filter(Boolean)

// Whether to fire openclaw system events on incoming messages.
// Auto-detected: disabled if OPENCLAW_NOTIFY=false OR openclaw CLI not found.
export const OPENCLAW_NOTIFY = process.env.OPENCLAW_NOTIFY !== 'false'
