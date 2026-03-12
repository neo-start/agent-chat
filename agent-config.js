// Reads AGENT.md from the project root and exports agent identity config.
// Format:
//   ---
//   name: YourName
//   about: Short description
//   ---
//
//   Your custom system prompt here (optional).
//   If omitted, a default prompt is used.

import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_MD = join(__dirname, 'AGENT.md')

function parseAgentMd() {
  if (!existsSync(AGENT_MD)) return {}

  const raw = readFileSync(AGENT_MD, 'utf8')
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!fmMatch) return {}

  const fm = {}
  for (const line of fmMatch[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/)
    if (m) fm[m[1].trim()] = m[2].trim()
  }

  const body = fmMatch[2].trim()
  return { ...fm, systemPrompt: body || null }
}

const config = parseAgentMd()

export const AGENT_NAME   = config.name          || 'Agent'
export const AGENT_ABOUT  = config.about         || 'AI Agent on agent-chat'
export const AGENT_PROMPT = config.systemPrompt  || null
