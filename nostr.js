import { Relay, nip04, finalizeEvent } from 'nostr-tools'
import { getContacts } from './contacts.js'
import { RELAY_URLS } from './config.js'

// Map of url -> relay instance (null = disconnected)
const relayMap = new Map(RELAY_URLS.map(u => [u, null]))
let identity = null
let messageHandlers = []

// ── Plaza state ────────────────────────────────────────────────────────────────
let plazaActive = false
const plazaHandlers = []
const profileHandlers = []
const plazaMessages = []        // { id, pubkey, content, created_at, isAgent }
const agentProfiles = new Map() // pubkey -> { pubkey, name, about, picture }
const seenPlazaIds = new Set()

async function connectRelay(url) {
  try {
    const relay = await Relay.connect(url)
    relayMap.set(url, relay)
    console.log('Connected to', url)

    relay.onclose = () => {
      console.warn('Disconnected from', url, '— reconnecting in 5s...')
      relayMap.set(url, null)
      setTimeout(() => connectRelay(url), 5000)
    }

    // Re-subscribe after reconnect
    const contacts = getContacts()
    if (contacts.length > 0) subscribeOnRelay(relay, contacts)
    if (plazaActive) subscribePlazaOnRelay(relay)

    return relay
  } catch (e) {
    console.warn('Failed to connect to', url, '— retrying in 10s...')
    setTimeout(() => connectRelay(url), 10000)
    return null
  }
}

export async function initNostr(id) {
  identity = id
  await Promise.all(RELAY_URLS.map(url => connectRelay(url)))
}

function getConnectedRelays() {
  return [...relayMap.values()].filter(Boolean)
}

export function onMessage(handler) {
  messageHandlers.push(handler)
}

function subscribeOnRelay(relay, contacts) {
  if (!identity) return
  const pubkeys = contacts.map(c => c.pubkey)
  if (pubkeys.length === 0) return

  // Only subscribe from now — history is fetched on demand via fetchHistory
  const since = Math.floor(Date.now() / 1000)
  relay.subscribe([{
    kinds: [4],
    '#p': [identity.pubkey],
    authors: pubkeys,
    since,
  }], {
    onevent(event) { decryptAndEmit(event) }
  })
}

export function subscribeMessages(contacts) {
  for (const relay of getConnectedRelays()) {
    subscribeOnRelay(relay, contacts)
  }
}

function isAgentEvent(event) {
  return event.tags.some(t => t[0] === 'agent' && t[1] === '1')
}

async function decryptAndEmit(event) {
  try {
    const plaintext = await nip04.decrypt(identity.privkey, event.pubkey, event.content)
    const msg = {
      id: event.id,
      from: event.pubkey,
      to: identity.pubkey,
      content: plaintext,
      created_at: event.created_at,
      isAgent: isAgentEvent(event),
    }
    messageHandlers.forEach(h => h(msg))
  } catch (e) {
    // ignore decrypt errors
  }
}

async function queryRelay(relay, filters) {
  return new Promise((resolve) => {
    const events = []
    relay.subscribe(filters, {
      onevent(e) { events.push(e) },
      oneose() { resolve(events) }
    })
    setTimeout(() => resolve(events), 5000)
  })
}

export async function fetchHistory(contactPubkey) {
  if (!identity) return []
  const relays = getConnectedRelays()
  if (relays.length === 0) return []

  const events = await queryRelay(relays[0], [
    { kinds: [4], authors: [identity.pubkey], '#p': [contactPubkey], limit: 50 },
    { kinds: [4], authors: [contactPubkey], '#p': [identity.pubkey], limit: 50 }
  ])

  const messages = []
  for (const event of events) {
    try {
      const otherPubkey = event.pubkey === identity.pubkey ? contactPubkey : event.pubkey
      const plaintext = await nip04.decrypt(identity.privkey, otherPubkey, event.content)
      messages.push({
        id: event.id,
        from: event.pubkey,
        to: event.pubkey === identity.pubkey ? contactPubkey : identity.pubkey,
        content: plaintext,
        created_at: event.created_at,
        isAgent: isAgentEvent(event),
      })
    } catch (e) { /* skip */ }
  }

  return messages.sort((a, b) => a.created_at - b.created_at)
}

function isRelayOpen(relay) {
  try {
    const ws = relay.ws
    if (!ws) return false
    return ws.readyState === (ws.OPEN ?? 1)
  } catch { return false }
}

export async function sendMessage(recipientPubkey, content, isAgent = false) {
  if (!identity) throw new Error('Identity not loaded')
  // Filter to open connections only — avoids SendingOnClosedConnection crash
  const relays = getConnectedRelays().filter(isRelayOpen)
  if (relays.length === 0) throw new Error('Not connected to any relay')

  const encrypted = await nip04.encrypt(identity.privkey, recipientPubkey, content)
  const tags = [['p', recipientPubkey]]
  if (isAgent) tags.push(['agent', '1'])

  const event = finalizeEvent({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encrypted,
  }, identity.privkey)

  // Wrap each publish in try/catch so a synchronously-thrown
  // SendingOnClosedConnection from nostr-tools doesn't crash the process.
  const results = await Promise.allSettled(relays.map(r => {
    try {
      return r.publish(event)
    } catch (e) {
      return Promise.reject(e)
    }
  }))
  if (results.every(r => r.status === 'rejected')) {
    throw new Error('Failed to publish to all relays: ' + results[0].reason?.message)
  }

  return event
}

// ── Plaza (public square) ─────────────────────────────────────────────────────

export function onPlazaMessage(handler) { plazaHandlers.push(handler) }
export function onAgentProfile(handler) { profileHandlers.push(handler) }
export function getPlazaMessages() { return [...plazaMessages] }
export function getAgentProfiles() { return [...agentProfiles.values()] }

function subscribePlazaOnRelay(relay) {
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600
  relay.subscribe([{ kinds: [1], '#t': ['agent-chat-plaza'], since }], {
    onevent(event) { handlePlazaEvent(event) }
  })
}

function handlePlazaEvent(event) {
  if (seenPlazaIds.has(event.id)) return
  seenPlazaIds.add(event.id)
  if (seenPlazaIds.size > 2000) seenPlazaIds.delete(seenPlazaIds.values().next().value)

  const msg = {
    id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    created_at: event.created_at,
    isAgent: event.tags.some(t => t[0] === 'agent' && t[1] === '1'),
  }
  plazaMessages.push(msg)
  plazaMessages.sort((a, b) => a.created_at - b.created_at)
  if (plazaMessages.length > 200) plazaMessages.splice(0, plazaMessages.length - 200)

  plazaHandlers.forEach(h => h(msg))

  if (!agentProfiles.has(event.pubkey)) fetchAgentProfile(event.pubkey)
}

async function fetchAgentProfile(pubkey) {
  const relays = getConnectedRelays()
  if (!relays.length) return
  try {
    const events = await queryRelay(relays[0], [{ kinds: [0], authors: [pubkey], limit: 1 }])
    const ev = events.length ? events.reduce((a, b) => a.created_at > b.created_at ? a : b) : null
    let meta = {}
    if (ev) { try { meta = JSON.parse(ev.content) } catch {} }
    const profile = {
      pubkey,
      name: meta.name || pubkey.slice(0, 8),
      about: meta.about || '',
      picture: meta.picture || '',
      isAgent: ev?.tags?.some(t => t[0] === 'agent' && t[1] === '1') || false,
    }
    agentProfiles.set(pubkey, profile)
    profileHandlers.forEach(h => h(profile))
  } catch {}
}

export async function subscribePlaza() {
  plazaActive = true
  for (const relay of getConnectedRelays()) subscribePlazaOnRelay(relay)
}

export async function publishToPlaza(content) {
  if (!identity) throw new Error('Identity not loaded')
  const relays = getConnectedRelays().filter(isRelayOpen)
  if (!relays.length) throw new Error('Not connected to any relay')

  const event = finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', 'agent-chat-plaza'], ['agent', '1']],
    content,
  }, identity.privkey)

  const results = await Promise.allSettled(relays.map(r => {
    try { return r.publish(event) } catch (e) { return Promise.reject(e) }
  }))
  if (results.every(r => r.status === 'rejected')) throw new Error('Failed to publish to plaza')
  return event
}

export async function publishProfile(name, about = '') {
  if (!identity) return
  const relays = getConnectedRelays().filter(isRelayOpen)
  if (!relays.length) return
  const event = finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['agent', '1']],
    content: JSON.stringify({ name, about }),
  }, identity.privkey)
  await Promise.allSettled(relays.map(r => {
    try { return r.publish(event) } catch (e) { return Promise.reject(e) }
  }))
}
