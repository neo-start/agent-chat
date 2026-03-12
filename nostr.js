import { Relay, nip04, finalizeEvent } from 'nostr-tools'

const RELAY_URLS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
]

let relays = []
let identity = null
let messageHandlers = []

export async function initNostr(id) {
  identity = id
  for (const url of RELAY_URLS) {
    try {
      const relay = await Relay.connect(url)
      relays.push(relay)
      console.log('Connected to', url)
    } catch (e) {
      console.warn('Failed to connect to', url, e.message)
    }
  }
}

export function onMessage(handler) {
  messageHandlers.push(handler)
}

export function subscribeMessages(contacts) {
  if (!identity || relays.length === 0) return
  const pubkeys = contacts.map(c => c.pubkey)
  if (pubkeys.length === 0) return

  const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7

  for (const relay of relays) {
    relay.subscribe([
      {
        kinds: [4],
        '#p': [identity.pubkey],
        authors: pubkeys,
        since,
      }
    ], {
      onevent(event) {
        decryptAndEmit(event)
      }
    })
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
    const sub = relay.subscribe(filters, {
      onevent(e) { events.push(e) },
      oneose() { resolve(events) }
    })
    setTimeout(() => resolve(events), 5000)
  })
}

export async function fetchHistory(contactPubkey) {
  if (!identity || relays.length === 0) return []

  const relay = relays[0]
  const events = await queryRelay(relay, [
    {
      kinds: [4],
      authors: [identity.pubkey],
      '#p': [contactPubkey],
      limit: 50,
    },
    {
      kinds: [4],
      authors: [contactPubkey],
      '#p': [identity.pubkey],
      limit: 50,
    }
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
    } catch (e) {
      // skip
    }
  }

  return messages.sort((a, b) => a.created_at - b.created_at)
}

export async function sendMessage(recipientPubkey, content, isAgent = false) {
  if (!identity || relays.length === 0) throw new Error('Not initialized')

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
