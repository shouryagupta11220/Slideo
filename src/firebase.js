import { getApps, initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { get, getDatabase, onDisconnect, onValue, push, ref, runTransaction, set, update } from 'firebase/database'
import { deleteObject, getDownloadURL, getStorage, ref as storageRef, uploadBytes } from 'firebase/storage'

const envConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}
const roomCodeCharacters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const pollsById = (polls) => Object.fromEntries((Array.isArray(polls) ? polls : polls ? Object.values(polls) : []).filter((poll) => poll?.id).map((poll) => [poll.id, poll]))

export function generateRoomCode() {
  const randomValues = new Uint8Array(8)
  crypto.getRandomValues(randomValues)
  return Array.from(randomValues, (value) => roomCodeCharacters[value % roomCodeCharacters.length]).join('')
}

export function readFirebaseConfig() {
  return Object.fromEntries(Object.entries(envConfig).filter(([, value]) => value))
}

export async function loadPresenterDraft(database, userId) {
  const snapshot = await get(ref(database, `presenterDrafts/${userId}`))
  return snapshot.val()
}

export function savePresenterDraft(database, userId, draft) {
  return set(ref(database, `presenterDrafts/${userId}`), { ...draft, updatedAt: Date.now() })
}

export async function deleteWorkspaceData(database, storage, userId, workspace) {
  const updates = {}
  const sessionIds = new Set([workspace.activeSessionId].filter(Boolean))
  const roomCodes = new Set()
  const sessionsSnapshot = await get(ref(database, 'sessions'))
  const sessions = sessionsSnapshot.val() || {}
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session?.workspaceId === workspace.id) sessionIds.add(sessionId)
  }
  for (const sessionId of sessionIds) {
    const session = sessions[sessionId]
    if (session?.authCode) roomCodes.add(String(session.authCode).toUpperCase())
    updates[`sessions/${sessionId}`] = null
  }
  const workspaceCode = workspace.session?.authCode ? String(workspace.session.authCode).toUpperCase() : null
  if (workspaceCode && workspace.activeSessionId) {
    const codeSnapshot = await get(ref(database, `roomCodes/${workspaceCode}`))
    if (codeSnapshot.val() === workspace.activeSessionId) roomCodes.add(workspaceCode)
  }
  for (const code of roomCodes) updates[`roomCodes/${code}`] = null
  if (workspace.session?.deck?.databasePath?.startsWith(`presenterDecks/${userId}/`)) {
    updates[workspace.session.deck.databasePath] = null
  }
  if (Object.keys(updates).length) await update(ref(database), updates)

  const deckUrl = workspace.session?.deck?.url
  if (deckUrl) await deleteObject(storageRef(storage, deckUrl)).catch((error) => {
    if (error.code !== 'storage/object-not-found') throw error
  })
}

export function connectFirebase(config) {
  const app = getApps().find((item) => item.options.appId === config.appId)
    || initializeApp(config, `slideo-${config.projectId}`)
  return { auth: getAuth(app), database: getDatabase(app), storage: getStorage(app) }
}

export async function uploadDeck(database, storage, userId, file) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-')
  if (/\.(ppt|pptx)$/i.test(file.name)) {
    if (!userId) throw new Error('Sign in before saving a PowerPoint deck.')
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error || new Error('Could not read the PowerPoint file.'))
      reader.readAsDataURL(file)
    })
    const deckRef = push(ref(database, `presenterDecks/${userId}`))
    await set(deckRef, {
      name: file.name,
      contentType: file.type || (file.name.toLowerCase().endsWith('.ppt') ? 'application/vnd.ms-powerpoint' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
      size: file.size,
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      createdAt: Date.now(),
    })
    return { databasePath: `presenterDecks/${userId}/${deckRef.key}` }
  }
  const destination = storageRef(storage, `decks/${Date.now()}-${safeName}`)
  await uploadBytes(destination, file, { contentType: file.type || 'application/octet-stream' })
  return { url: await getDownloadURL(destination) }
}

export async function loadPresenterDeck(database, databasePath) {
  const snapshot = await get(ref(database, databasePath))
  return snapshot.val()
}

export async function createRemoteSession(database, session, workspaceId) {
  const sessionRef = push(ref(database, 'sessions'))
  let authCode
  let codeRef
  const preferredCode = session.authCode ? String(session.authCode).toUpperCase() : null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    authCode = attempt === 0 && preferredCode ? preferredCode : generateRoomCode()
    codeRef = ref(database, `roomCodes/${authCode}`)
    const reservation = await runTransaction(codeRef, (current) => current === null ? sessionRef.key : undefined, { applyLocally: false })
    if (reservation.committed) break
    if (preferredCode) {
      const existingId = await get(codeRef).then((snapshot) => snapshot.val())
      if (existingId && existingId !== sessionRef.key) {
        const existingSession = await get(ref(database, `sessions/${existingId}`)).then((snapshot) => snapshot.val())
        if (existingSession?.workspaceId === workspaceId && existingSession.status === 'ended') {
          const transferred = await runTransaction(codeRef, (current) => current === existingId ? sessionRef.key : undefined, { applyLocally: false })
          if (transferred.committed) break
        }
      }
      throw new Error('This room code is already in use. Reset the room code and try again.')
    }
    authCode = null
  }
  if (!authCode) throw new Error('Could not reserve a unique room code. Please try again.')
  try {
    await set(sessionRef, { ...session, workspaceId, polls: pollsById(session.polls), authCode, createdAt: Date.now() })
  } catch (error) {
    await set(codeRef, null).catch(() => {})
    throw error
  }
  return { id: sessionRef.key, authCode }
}

export async function resolveRoomCode(database, authCode) {
  const snapshot = await get(ref(database, `roomCodes/${authCode.toUpperCase()}`))
  return snapshot.val()
}

export function subscribeSession(database, sessionId, callback) {
  return onValue(ref(database, `sessions/${sessionId}`), (snapshot) => callback(snapshot.val()))
}

export function patchSession(database, sessionId, values) {
  const patch = Object.hasOwn(values, 'polls') ? { ...values, polls: pollsById(values.polls) } : values
  return update(ref(database, `sessions/${sessionId}`), patch)
}

export async function reserveRoomCode(database, sessionId, preferredCode, previousCode) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const authCode = attempt === 0 && preferredCode ? String(preferredCode).toUpperCase() : generateRoomCode()
    const reservation = await runTransaction(ref(database, `roomCodes/${authCode}`), (current) => current === null ? sessionId : undefined, { applyLocally: false })
    if (reservation.committed) {
      if (previousCode && previousCode !== authCode) {
        await runTransaction(ref(database, `roomCodes/${String(previousCode).toUpperCase()}`), (current) => current === sessionId ? null : undefined, { applyLocally: false })
      }
      return authCode
    }
  }
  throw new Error('Could not reserve a unique room code. Please try again.')
}

export function patchPoll(database, sessionId, pollId, values) {
  return update(ref(database, `sessions/${sessionId}/polls/${pollId}`), values)
}

export function writeVote(database, sessionId, pollId, attendeeId, answerIndex) {
  return set(ref(database, `sessions/${sessionId}/polls/${pollId}/responses/${attendeeId}`), answerIndex)
}

export async function registerAttendee(database, sessionId, attendeeId, name = null) {
  const participantRef = ref(database, `sessions/${sessionId}/participants/${attendeeId}`)
  await onDisconnect(participantRef).remove()
  return set(participantRef, { joinedAt: Date.now(), ...(name ? { name } : {}) })
}

export function sendJoinRequest(database, sessionId, user) {
  const requestRef = ref(database, `sessions/${sessionId}/joinRequests/${user.uid}`)
  return runTransaction(requestRef, (current) => {
    if (current?.status === 'pending' || current?.status === 'approved') return
    const attempts = current ? Number(current.attempts) || 1 : 0
    if (attempts >= 3) return
    return {
      uid: user.uid, name: user.displayName || user.email || 'Participant', email: user.email || '',
      requestedAt: Date.now(), status: 'pending', attempts: attempts + 1,
    }
  }, { applyLocally: false }).then((result) => {
    if (!result.committed && Number(result.snapshot.val()?.attempts) >= 3) {
      throw new Error('You have used all 3 join requests for this presentation.')
    }
    return result
  })
}

export function approveJoinRequest(database, sessionId, uid, name) {
  return update(ref(database), {
    [`sessions/${sessionId}/joinRequests/${uid}/status`]: 'approved',
    [`sessions/${sessionId}/participants/${uid}`]: { joinedAt: Date.now(), name: name || 'Participant' },
  })
}

export function rejectJoinRequest(database, sessionId, uid) {
  return update(ref(database), { [`sessions/${sessionId}/joinRequests/${uid}/status`]: 'rejected' })
}
