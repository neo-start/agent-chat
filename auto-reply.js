// Auto-reply module: uses claude-proxy (OpenAI-compatible API at port 11435)
// to automatically respond to incoming messages from contacts.

import { sendMessage } from './nostr.js'
import { getMessages, saveMessage } from './storage.js'

// Config via env vars (with defaults for local dev)
const CLAUDE_API_URL = process.env.CLAUDE_API_URL || 'http://localhost:11435/v1/chat/completions'
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-placeholder'
const CLAUDE_MODEL   = process.env.CLAUDE_MODEL   || 'claude-proxy'
const MAX_HISTORY    = parseInt(process.env.AUTO_REPLY_HISTORY || '20', 10)
const AUTO_REPLY_ENABLED_DEFAULT = process.env.AUTO_REPLY !== 'false'

let enabled = AUTO_REPLY_ENABLED_DEFAULT

export function setAutoReplyEnabled(val) {
  enabled = val
}

export function isAutoReplyEnabled() {
  return enabled
}

// Build conversation history for a contact (last N messages)
function buildHistory(contactPubkey, identity) {
  const messages = getMessages(contactPubkey)
  const recent = messages.slice(-MAX_HISTORY)

  return recent.map(msg => ({
    role: msg.from === identity.pubkey ? 'assistant' : 'user',
    content: msg.content,
  }))
}

// System prompts per trust level
const SYSTEM_PROMPTS = {
  1: (name) => `You are BT-X, an AI assistant. You are chatting with ${name} via a Nostr-based P2P messaging app. Keep replies concise and natural. Respond in the same language the user uses.`,
  2: (name) => `You are BT-X, an AI assistant with read access to the host machine. You are chatting with ${name} (trusted user). You can answer questions about system status, files, and information. Keep replies concise. Respond in the same language the user uses.`,
  3: (name) => `You are BT-X, an AI assistant with full access to the host machine. You are chatting with ${name} (highly trusted user). You can execute commands, open applications, and perform operations on the machine when asked. Be careful and confirm destructive actions. Respond in the same language the user uses.`,
}

export async function autoReply(incomingMsg, identity, contact) {
  if (!enabled) return
  // Don't reply to our own messages or agent messages
  if (incomingMsg.from === identity.pubkey) return
  if (incomingMsg.isAgent) return

  const trustLevel = contact?.trustLevel ?? 0
  // Level 0: silent — don't consume tokens
  if (trustLevel === 0) return

  const contactName = contact?.name || incomingMsg.from.slice(0, 8)
  const systemPrompt = (SYSTEM_PROMPTS[trustLevel] || SYSTEM_PROMPTS[1])(contactName)

  try {
    const history = buildHistory(incomingMsg.from, identity)

    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CLAUDE_API_KEY}`,
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
        ],
        max_tokens: 500,
      }),
    })

    if (!response.ok) {
      console.error('Auto-reply API error:', response.status, await response.text())
      return
    }

    const data = await response.json()
    const replyText = data.choices?.[0]?.message?.content
    if (!replyText) return

    // Send via Nostr
    const event = await sendMessage(incomingMsg.from, replyText, true)

    // Save locally
    const sentMsg = {
      id: event.id,
      from: identity.pubkey,
      to: incomingMsg.from,
      content: replyText,
      created_at: event.created_at,
      isAgent: true,
    }
    saveMessage(incomingMsg.from, sentMsg)

    console.log(`[auto-reply] → ${contactName}: ${replyText.slice(0, 60)}`)
    return sentMsg
  } catch (e) {
    console.error('[auto-reply] Error:', e.message)
  }
}
