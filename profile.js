import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from './config.js'
import { AGENT_NAME, AGENT_ABOUT } from './agent-config.js'

const PROFILE_FILE = join(DATA_DIR, 'profile.json')

function defaults() {
  return { name: AGENT_NAME || '', about: AGENT_ABOUT || '' }
}

export function getProfile() {
  mkdirSync(DATA_DIR, { recursive: true })
  if (!existsSync(PROFILE_FILE)) return defaults()
  try {
    return { ...defaults(), ...JSON.parse(readFileSync(PROFILE_FILE, 'utf8')) }
  } catch { return defaults() }
}

export function saveProfile(updates) {
  mkdirSync(DATA_DIR, { recursive: true })
  const current = getProfile()
  const updated = { ...current, ...updates }
  writeFileSync(PROFILE_FILE, JSON.stringify(updated, null, 2))
  return updated
}

export function isProfileSet() {
  return !!getProfile().name
}
