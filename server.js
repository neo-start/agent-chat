// Load .env if present (no dependency required — manual parse)
import { existsSync, readFileSync as _rfs } from 'fs'
const envPath = new URL('.env', import.meta.url).pathname
if (existsSync(envPath)) {
  _rfs(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  })
}

import http from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { exec } from 'child_process'
import { getIdentity } from './identity.js'
import { getContacts, addContact, renameContact, setTrustLevel } from './contacts.js'
import { initNostr, onMessage, subscribeMessages, fetchHistory, sendMessage,
  subscribePlaza, publishToPlaza, publishProfile,
  onPlazaMessage, onAgentProfile, getPlazaMessages, getAgentProfiles } from './nostr.js'
import { getMessages, saveMessage, mergeMessages } from './storage.js'
import { autoReply, setAutoReplyEnabled, isAutoReplyEnabled } from './auto-reply.js'
import { PORT, OPENCLAW_NOTIFY } from './config.js'
import { AGENT_NAME, AGENT_ABOUT } from './agent-config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const identity = getIdentity()
console.log('Your public key (npub):', identity.npub)

// Webhook: POST incoming messages to this URL (env: AGENT_CHAT_WEBHOOK)
const WEBHOOK_URL = process.env.AGENT_CHAT_WEBHOOK || null

async function fireWebhook(msg, contact) {
  if (!WEBHOOK_URL) return
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'message',
        from: msg.from,
        fromName: contact?.name || msg.from.slice(0, 8),
        content: msg.content,
        isAgent: msg.isAgent,
        created_at: msg.created_at,
      }),
    })
  } catch (e) {
    console.warn('Webhook failed:', e.message)
  }
}

// ── HTTP API helpers ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { reject(new Error('Invalid JSON')) } })
    req.on('error', reject)
  })
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const url = new URL(req.url, `http://localhost:${PORT}`)

  // ── Web UI ──
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(html)
  }

  // ── REST API ──

  // GET /api/identity
  if (req.method === 'GET' && url.pathname === '/api/identity') {
    return json(res, 200, { pubkey: identity.pubkey, npub: identity.npub })
  }

  // GET /api/contacts
  if (req.method === 'GET' && url.pathname === '/api/contacts') {
    return json(res, 200, getContacts())
  }

  // POST /api/contacts  { npub, name }
  if (req.method === 'POST' && url.pathname === '/api/contacts') {
    try {
      const body = await readBody(req)
      const contact = addContact(body.npub, body.name)
      if (contact.error) return json(res, 400, { error: contact.error })
      subscribeMessages(getContacts())
      broadcast({ type: 'contacts', data: getContacts() })
      return json(res, 201, contact)
    } catch (e) {
      return json(res, 400, { error: e.message })
    }
  }

  // GET /api/messages/:pubkey
  const msgMatch = url.pathname.match(/^\/api\/messages\/([0-9a-f]{64})$/)
  if (req.method === 'GET' && msgMatch) {
    return json(res, 200, getMessages(msgMatch[1]))
  }

  // PATCH /api/contacts/:pubkey  { name?, trustLevel? }
  const contactMatch = url.pathname.match(/^\/api\/contacts\/([0-9a-f]{64})$/)
  if (req.method === 'PATCH' && contactMatch) {
    try {
      const body = await readBody(req)
      let result
      if (body.name !== undefined) {
        result = renameContact(contactMatch[1], body.name)
      }
      if (body.trustLevel !== undefined) {
        result = setTrustLevel(contactMatch[1], body.trustLevel)
      }
      if (!result) return json(res, 400, { error: 'Provide name or trustLevel' })
      if (result.error) return json(res, 404, { error: result.error })
      broadcast({ type: 'contacts', data: getContacts() })
      return json(res, 200, result)
    } catch (e) {
      return json(res, 400, { error: e.message })
    }
  }

  // POST /api/send  { to, content, isAgent? }
  if (req.method === 'POST' && url.pathname === '/api/send') {
    try {
      const body = await readBody(req)
      if (!body.to || !body.content) return json(res, 400, { error: 'to and content required' })
      const isAgent = !!body.isAgent
      const event = await sendMessage(body.to, body.content, isAgent)
      const sentMsg = {
        id: event.id,
        from: identity.pubkey,
        to: body.to,
        content: body.content,
        created_at: event.created_at,
        isAgent,
      }
      saveMessage(body.to, sentMsg)
      broadcast({ type: 'message', data: sentMsg })
      return json(res, 200, { ok: true, id: event.id })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // GET /api/plaza/messages
  if (req.method === 'GET' && url.pathname === '/api/plaza/messages') {
    return json(res, 200, getPlazaMessages())
  }

  // GET /api/plaza/agents
  if (req.method === 'GET' && url.pathname === '/api/plaza/agents') {
    return json(res, 200, getAgentProfiles())
  }

  // POST /api/plaza/send  { content }
  if (req.method === 'POST' && url.pathname === '/api/plaza/send') {
    try {
      const body = await readBody(req)
      if (!body.content) return json(res, 400, { error: 'content required' })
      const event = await publishToPlaza(body.content)
      const msg = { id: event.id, pubkey: identity.pubkey, content: body.content, created_at: event.created_at, isAgent: true }
      broadcast({ type: 'plaza_message', data: msg })
      return json(res, 200, { ok: true })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // GET /api/auto-reply
  if (req.method === 'GET' && url.pathname === '/api/auto-reply') {
    return json(res, 200, { enabled: isAutoReplyEnabled() })
  }

  // POST /api/auto-reply  { enabled: bool }
  if (req.method === 'POST' && url.pathname === '/api/auto-reply') {
    try {
      const body = await readBody(req)
      setAutoReplyEnabled(!!body.enabled)
      return json(res, 200, { enabled: isAutoReplyEnabled() })
    } catch (e) {
      return json(res, 400, { error: e.message })
    }
  }

  res.writeHead(404)
  res.end('Not found')
})

// ── WebSocket ─────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server })
const clients = new Set()

function broadcast(data) {
  const msg = JSON.stringify(data)
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg) })
}

const seenEventIds = new Set()

onMessage(msg => {
  // Deduplicate across relays
  if (seenEventIds.has(msg.id)) return
  seenEventIds.add(msg.id)
  // Prevent unbounded growth
  if (seenEventIds.size > 1000) {
    const first = seenEventIds.values().next().value
    seenEventIds.delete(first)
  }

  const contactPubkey = msg.from === identity.pubkey ? msg.to : msg.from
  saveMessage(contactPubkey, msg)
  broadcast({ type: 'message', data: msg })

  // Notify agent for incoming messages (not sent by us)
  if (msg.from !== identity.pubkey) {
    const contact = getContacts().find(c => c.pubkey === msg.from)
    fireWebhook(msg, contact)
    const name = contact?.name || msg.from.slice(0, 8)
    const trustLevel = contact?.trustLevel ?? 0
    const preview = msg.content.length > 60 ? msg.content.slice(0, 60) + '...' : msg.content
    // Trust level 0: silent — don't wake up main session at all
    if (OPENCLAW_NOTIFY && trustLevel > 0) {
      const trustLabel = ['', 'chat', 'query', 'exec'][trustLevel] || 'chat'
      // Include trust level in notification so main session knows what this contact is allowed to do
      exec(`openclaw system event --text "agent-chat [trust:${trustLevel}/${trustLabel}] ${name}: ${preview}" --mode now`, (err) => {
        if (err && err.code === 'ENOENT') {
          process.env.OPENCLAW_NOTIFY = 'false'
        }
      })
    }

    // Auto-reply via Claude
    autoReply(msg, identity, contact).then(sentMsg => {
      if (sentMsg) broadcast({ type: 'message', data: sentMsg })
    })
  }
})

wss.on('connection', (ws) => {
  clients.add(ws)

  ws.send(JSON.stringify({ type: 'identity', data: { pubkey: identity.pubkey, npub: identity.npub } }))
  ws.send(JSON.stringify({ type: 'contacts', data: getContacts() }))
  ws.send(JSON.stringify({ type: 'plaza_messages', data: getPlazaMessages() }))
  ws.send(JSON.stringify({ type: 'plaza_agents', data: getAgentProfiles() }))

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
            subscribeMessages(getContacts())
          }
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', data: e.message }))
        }
        break
      }

      case 'load_history': {
        try {
          const cached = getMessages(msg.pubkey)
          ws.send(JSON.stringify({ type: 'history', data: { pubkey: msg.pubkey, messages: cached } }))
          const remote = await fetchHistory(msg.pubkey)
          mergeMessages(msg.pubkey, remote)
          ws.send(JSON.stringify({ type: 'history', data: { pubkey: msg.pubkey, messages: getMessages(msg.pubkey) } }))
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', data: e.message }))
        }
        break
      }

      case 'rename_contact': {
        const result = renameContact(msg.pubkey, msg.name)
        if (result.error) {
          ws.send(JSON.stringify({ type: 'error', data: result.error }))
        } else {
          broadcast({ type: 'contacts', data: getContacts() })
        }
        break
      }

      case 'send_message': {
        try {
          const isAgent = !!msg.isAgent
          const event = await sendMessage(msg.to, msg.content, isAgent)
          const sentMsg = {
            id: event.id,
            from: identity.pubkey,
            to: msg.to,
            content: msg.content,
            created_at: event.created_at,
            isAgent,
            _tempId: msg._tempId,  // echo back so UI can resolve pending state
          }
          saveMessage(msg.to, { id: event.id, from: identity.pubkey, to: msg.to, content: msg.content, created_at: event.created_at, isAgent })
          broadcast({ type: 'message', data: sentMsg })
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', data: e.message }))
        }
        break
      }
    }
  })

  ws.on('close', () => clients.delete(ws))
})

// ── Start ─────────────────────────────────────────────────────────────────────

// ── Plaza event handlers ───────────────────────────────────────────────────────
onPlazaMessage(msg => broadcast({ type: 'plaza_message', data: msg }))
onAgentProfile(profile => broadcast({ type: 'plaza_agent', data: profile }))

initNostr(identity).then(() => {
  subscribeMessages(getContacts())
  subscribePlaza()
  publishProfile(AGENT_NAME, AGENT_ABOUT).catch(() => {})
  server.listen(PORT, () => {
    console.log(`Agent Chat running at http://localhost:${PORT}`)
    console.log(`REST API: http://localhost:${PORT}/api/`)
  })
})
