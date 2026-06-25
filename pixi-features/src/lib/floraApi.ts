/**
 * Flora API client for pixi-features.
 *
 * Slim port of flora-uxp's flora-fetch.ts: Basic Auth from localStorage,
 * Railway base URL, JSON + binary helpers.
 *
 * Auth state is exposed as a Vue ref so LoginPanel and consumers can react.
 */

import { ref, readonly } from 'vue'

const STORAGE_KEY_BASIC_AUTH = 'flora_auth_basic'
const STORAGE_KEY_USERNAME = 'flora_auth_username'
// Backend moved from zamia-design.com to Railway (behind.buildflora.com),
// matching flora-studio's default. Override with VITE_API_BASE_URL if needed.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'https://behind.buildflora.com'
const FETCH_TIMEOUT_MS = 30_000

export class FloraApiError extends Error {
  constructor(public status: number, public body: unknown, message?: string) {
    super(message ?? `Flora API error: ${status}`)
    this.name = 'FloraApiError'
  }
}

const storedCreds = localStorage.getItem(STORAGE_KEY_BASIC_AUTH)
const storedUser = localStorage.getItem(STORAGE_KEY_USERNAME)

const _isLoggedIn = ref<boolean>(Boolean(storedCreds))
const _username = ref<string>(storedUser ?? '')

export const isLoggedIn = readonly(_isLoggedIn)
export const username = readonly(_username)
export const apiBaseUrl = API_BASE_URL

/**
 * Re-syncs the reactive auth state with the current localStorage values.
 * Call this when a tab mounts, in case credentials were injected by a test
 * harness or another tab between page load and tab activation.
 */
export function refreshAuthState(): void {
  const creds = localStorage.getItem(STORAGE_KEY_BASIC_AUTH)
  const user = localStorage.getItem(STORAGE_KEY_USERNAME)
  _isLoggedIn.value = Boolean(creds)
  _username.value = user ?? ''
}

function authHeaders(): Record<string, string> {
  const encoded = localStorage.getItem(STORAGE_KEY_BASIC_AUTH)
  return encoded ? { Authorization: `Basic ${encoded}` } : {}
}

/**
 * Verifies credentials by calling a known authenticated endpoint.
 * On success, persists base64(user:pass) to localStorage and flips isLoggedIn.
 */
export async function login(user: string, pass: string): Promise<void> {
  const encoded = btoa(`${user}:${pass}`)

  const response = await fetch(`${API_BASE_URL}/api/auth/check/`, {
    method: 'GET',
    headers: { Authorization: `Basic ${encoded}` },
  })

  if (!response.ok) {
    throw new FloraApiError(
      response.status,
      await response.text(),
      response.status === 401 ? 'Invalid username or password' : `Login failed (${response.status})`,
    )
  }

  localStorage.setItem(STORAGE_KEY_BASIC_AUTH, encoded)
  localStorage.setItem(STORAGE_KEY_USERNAME, user)
  _isLoggedIn.value = true
  _username.value = user
}

export function logout(): void {
  localStorage.removeItem(STORAGE_KEY_BASIC_AUTH)
  localStorage.removeItem(STORAGE_KEY_USERNAME)
  _isLoggedIn.value = false
  _username.value = ''
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * JSON fetch — returns parsed body or throws FloraApiError.
 */
export async function floraFetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
  })

  if (!response.ok) {
    const body = await response.text()
    if (response.status === 401) _isLoggedIn.value = false
    throw new FloraApiError(response.status, body)
  }

  return response.json() as Promise<T>
}

/**
 * Binary fetch — returns raw ArrayBuffer (e.g. zip bundles, SVG bytes).
 */
export async function floraFetchBytes(path: string, init: RequestInit = {}): Promise<ArrayBuffer> {
  const response = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
  })

  if (!response.ok) {
    const body = await response.text()
    if (response.status === 401) _isLoggedIn.value = false
    throw new FloraApiError(response.status, body)
  }

  return response.arrayBuffer()
}
