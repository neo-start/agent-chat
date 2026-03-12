// Auto-reply module: uses claude-proxy (OpenAI-compatible API at port 11435)
// to automatically respond to incoming messages from contacts.

import { sendMessage } from './nostr.js'
import { getMessages, saveMessage } from './storage.js'

const CLAUDE_PROXY_URL = 'http://localhost:11435/v1/chat/completions'
const MODEL = 'claude-proxy'
const MAX_HISTORY = 20  // max messages to include as context

let enabled = true

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

export async function autoReply(incomingMsg, identity, contact) {
  if (!enabled) return
  // Don't reply to our own messages or agent messages
  if (incomingMsg.from === identity.pubkey) return
  if (incomingMsg.isAgent) return

  const contactName = contact?.name || incomingMsg.from.slice(0, 8)

  try {
    const history = buildHistory(incomingMsg.from, identity)

    const response = await fetch(CLAUDE_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: `You are BT-X, an AI assistant. You are chatting with ${contactName} via a Nostr-based P2P messaging app. Keep replies concise and natural. Respond in the same language the user uses.`,
          },
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
