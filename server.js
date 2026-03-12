import http from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { getIdentity } from './identity.js'
import { getContacts, addContact } from './contacts.js'
import { initNostr, onMessage, subscribeMessages, fetchHistory, sendMessage } from './nostr.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 3737

// Init identity and nostr
const identity = getIdentity()
console.log('Your public key (npub):', identity.npub)

// HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  } else {
    res.writeHead(404)
    res.end('Not found')
  }
})

// WebSocket server
const wss = new WebSocketServer({ server })
const clients = new Set()

function broadcast(data) {
  const msg = JSON.stringify(data)
  clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg)
  })
}

// Forward incoming Nostr messages to all browser clients
onMessage(msg => {
  broadcast({ type: 'message', data: msg })
})

wss.on('connection', (ws) => {
  clients.add(ws)

  // Send identity on connect
  ws.send(JSON.stringify({
    type: 'identity',
    data: { pubkey: identity.pubkey, npub: identity.npub }
  }))

  // Send contacts
  ws.send(JSON.stringify({
    type: 'contacts',
    data: getContacts()
  }))

  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    switch (msg.type) {
      case 'add_contact': {
        try {
          const contact = addContact(msg.npub, msg.name)
          if (contact.error) {
            ws.send(JSON.stringify({ type: 'error', data: contact.error }))
          } else {
            broadcast({ type: 'contacts', data: getContacts() })
            // Subscribe to new contact's messages
            subscribeMessages(getContacts())
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', data: e.message }))
        }
        break
      }

      case 'load_history': {
        try {
          const history = await fetchHistory(msg.pubkey)
          ws.send(JSON.stringify({ type: 'history', data: { pubkey: msg.pubkey, messages: history } }))
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', data: e.message }))
        }
        break
      }

      case 'send_message': {
        try {
          const event = await sendMessage(msg.to, msg.content)
          // Echo back as a sent message
          broadcast({
            type: 'message',
            data: {
              id: event.id,
              from: identity.pubkey,
              to: msg.to,
              content: msg.content,
              created_at: event.created_at,
            }
          })
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', data: e.message }))
        }
        break
      }
    }
  })

  ws.on('close', () => clients.delete(ws))
})

// Init nostr then start server
initNostr(identity).then(() => {
  subscribeMessages(getContacts())
  server.listen(PORT, () => {
    console.log(`Agent Chat running at http://localhost:${PORT}`)
  })
})
