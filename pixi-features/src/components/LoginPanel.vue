<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { isLoggedIn, username, login, logout, FloraApiError, apiBaseUrl } from '../lib/floraApi'

const apiHost = apiBaseUrl.replace(/^https?:\/\//, '')

const STORAGE_KEY_BASIC_AUTH = 'flora_auth_basic'
const STORAGE_KEY_USERNAME = 'flora_auth_username'

const usernameInput = ref('')
const passwordInput = ref('')
const showPassword = ref(false)
const loginInProgress = ref(false)
const errorMessage = ref('')

/**
 * On mount, pre-fill the form from saved credentials so the user doesn't
 * retype every session. We decode flora_auth_basic since it's already
 * base64(user:pass) — no extra storage.
 */
onMounted(() => {
  const savedUser = localStorage.getItem(STORAGE_KEY_USERNAME)
  if (savedUser) usernameInput.value = savedUser

  const savedAuth = localStorage.getItem(STORAGE_KEY_BASIC_AUTH)
  if (savedAuth) {
    try {
      const decoded = atob(savedAuth)
      const colon = decoded.indexOf(':')
      if (colon > 0) {
        if (!usernameInput.value) usernameInput.value = decoded.slice(0, colon)
        passwordInput.value = decoded.slice(colon + 1)
      }
    } catch {
      // Ignore malformed value (e.g. cleared by an audit run).
    }
  }
})

async function onSignIn() {
  if (!usernameInput.value || !passwordInput.value) {
    errorMessage.value = 'Username and password required'
    return
  }
  loginInProgress.value = true
  errorMessage.value = ''
  try {
    await login(usernameInput.value, passwordInput.value)
    passwordInput.value = ''
  } catch (err) {
    errorMessage.value =
      err instanceof FloraApiError ? err.message : 'Login failed. Check credentials.'
  } finally {
    loginInProgress.value = false
  }
}

function onSignOut() {
  logout()
  errorMessage.value = ''
}
</script>

<template>
  <div class="login-panel">
    <div v-if="isLoggedIn" class="logged-in">
      <span class="status-pill connected">
        <span class="dot" />
        Connected as <strong>{{ username }}</strong>
      </span>
      <button class="btn-secondary" @click="onSignOut">Sign Out</button>
    </div>

    <div v-else class="login-form">
      <h3>Sign in to Flora</h3>
      <p class="hint">Connects to <code>{{ apiHost }}</code></p>

      <div class="field">
        <label>Username</label>
        <input
          v-model="usernameInput"
          type="text"
          autocomplete="username"
          @keyup.enter="onSignIn"
        />
      </div>

      <div class="field">
        <label>Password</label>
        <div class="password-row">
          <input
            v-model="passwordInput"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="current-password"
            @keyup.enter="onSignIn"
          />
          <button
            type="button"
            class="toggle"
            :title="showPassword ? 'Hide' : 'Show'"
            @click="showPassword = !showPassword"
          >
            {{ showPassword ? '🙈' : '👁' }}
          </button>
        </div>
      </div>

      <button class="btn-primary" :disabled="loginInProgress" @click="onSignIn">
        {{ loginInProgress ? 'Signing in…' : 'Sign In' }}
      </button>

      <div v-if="errorMessage" class="error">{{ errorMessage }}</div>
    </div>
  </div>
</template>

<style scoped>
.login-panel {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: #e0e0e0;
}

.logged-in {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: #1a1f1a;
  border: 1px solid #2a3a2a;
  border-radius: 6px;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #6fdc6f;
}
.status-pill .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6fdc6f;
}

.login-form {
  max-width: 360px;
  padding: 20px;
  background: #181818;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
}
.login-form h3 {
  margin: 0 0 4px 0;
  font-size: 16px;
  color: #6fdc6f;
}
.hint {
  margin: 0 0 16px 0;
  font-size: 11px;
  color: #888;
}
.hint code {
  background: #222;
  padding: 1px 4px;
  border-radius: 3px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}
.field label {
  font-size: 11px;
  color: #aaa;
}

input[type='text'],
input[type='password'] {
  width: 100%;
  padding: 8px 10px;
  background: #222;
  border: 1px solid #333;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 13px;
  font-family: inherit;
  box-sizing: border-box;
}
input:focus {
  outline: none;
  border-color: #6fdc6f;
}

.password-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.password-row input {
  flex: 1;
}
.toggle {
  padding: 6px 8px;
  background: transparent;
  border: 1px solid #333;
  border-radius: 4px;
  color: #aaa;
  cursor: pointer;
}

.btn-primary,
.btn-secondary {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.btn-primary {
  background: #6fdc6f;
  color: #0a0a0a;
  width: 100%;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-secondary {
  background: #2a2a2a;
  color: #e0e0e0;
}

.error {
  margin-top: 12px;
  padding: 8px 10px;
  background: rgba(239, 83, 80, 0.15);
  border: 1px solid rgba(239, 83, 80, 0.3);
  border-radius: 4px;
  color: #ef5350;
  font-size: 12px;
}
</style>
