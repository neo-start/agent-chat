import { Relay, nip04, finalizeEvent } from 'nostr-tools'
import { getContacts } from './contacts.js'

const RELAY_URLS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
]

// Map of url -> relay instance (null = disconnected)
const relayMap = new Map(RELAY_URLS.map(u => [u, null]))
let identity = null
let messageHandlers = []

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

  const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7
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

export async function sendMessage(recipientPubkey, content, isAgent = false) {
  const relays = getConnectedRelays()
  if (!identity || relays.length === 0) throw new Error('Not connected to any relay')

  const encrypted = await nip04.encrypt(identity.privkey, recipientPubkey, content)
  const tags = [['p', recipientPubkey]]
  if (isAgent) tags.push(['agent', '1'])

  const event = finalizeEvent({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: encrypted,
  }, identity.privkey)

  const results = await Promise.allSettled(relays.map(r => r.publish(event)))
  if (results.every(r => r.status === 'rejected')) {
    throw new Error('Failed to publish to all relays')
  }

  return event
}
