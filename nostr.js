import { SimplePool, nip04, kinds } from 'nostr-tools'
import { finalizeEvent } from 'nostr-tools'

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
]

let pool = null
let identity = null
let messageHandlers = []

export function initNostr(id) {
  identity = id
  pool = new SimplePool()
  return pool
}

export function onMessage(handler) {
  messageHandlers.push(handler)
}

export async function subscribeMessages(contacts) {
  if (!pool || !identity) return

  const pubkeys = contacts.map(c => c.pubkey)
  if (pubkeys.length === 0) return

  // Subscribe to incoming DMs
  const sub = pool.subscribeMany(RELAYS, [
    {
      kinds: [kinds.EncryptedDirectMessage],
      '#p': [identity.pubkey],
      authors: pubkeys,
      since: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 7, // last 7 days
    }
  ], {
    onevent(event) {
      decryptAndEmit(event)
    }
  })

  return sub
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
    }
    messageHandlers.forEach(h => h(msg))
  } catch (e) {
    // ignore decrypt errors (messages not meant for us, etc.)
  }
}

export async function fetchHistory(contactPubkey) {
  if (!pool || !identity) return []

  const events = await pool.querySync(RELAYS, [
    {
      kinds: [kinds.EncryptedDirectMessage],
      authors: [identity.pubkey],
      '#p': [contactPubkey],
      limit: 50,
    },
    {
      kinds: [kinds.EncryptedDirectMessage],
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
      })
    } catch (e) {
      // skip
    }
  }

  return messages.sort((a, b) => a.created_at - b.created_at)
}

export async function sendMessage(recipientPubkey, content) {
  if (!pool || !identity) throw new Error('Not initialized')

  const encrypted = await nip04.encrypt(identity.privkey, recipientPubkey, content)

  const event = finalizeEvent({
    kind: kinds.EncryptedDirectMessage,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPubkey]],
    content: encrypted,
  }, identity.privkey)

  await Promise.any(pool.publish(RELAYS, event))
  return event
}
