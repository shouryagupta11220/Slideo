import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
    createUserWithEmailAndPassword, GoogleAuthProvider, onAuthStateChanged,
    signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile,
} from 'firebase/auth'
import {
    ArrowDownToLine, ArrowLeft, ArrowRight, Check, CheckCircle2,
    CircleHelp, Copy, Eye, FilePlus2, KeyRound, Link2, LoaderCircle, LockKeyhole,
    BarChart3, LogIn, LogOut, Maximize2, Minimize2, MonitorPlay, Plus, Presentation, Radio, Sparkles, Square,
    Pencil, RefreshCw, Trash2, Upload, Users, X,
} from 'lucide-react'
import {
    connectFirebase, createRemoteSession, deleteWorkspaceData, generateRoomCode, loadPresenterDeck, loadPresenterDraft, patchPoll, patchSession, readFirebaseConfig,
    approveJoinRequest, registerAttendee, rejectJoinRequest, reserveRoomCode, resolveRoomCode, savePresenterDraft, sendJoinRequest, subscribeSession, uploadDeck, writeVote,
} from './firebase'

const localKey = 'slideo-local-session'
const makeWorkspaceId = () => `workspace-${Math.random().toString(36).slice(2, 10)}`
function readStoredWorkspaces(storageKey, legacyKey) {
    try {
        const stored = JSON.parse(localStorage.getItem(storageKey))
        if (Array.isArray(stored?.workspaces)) return stored.workspaces
        const legacySession = JSON.parse(localStorage.getItem(legacyKey))
        if (legacySession && typeof legacySession === 'object') return [{ id: 'workspace-legacy', name: 'Untitled', session: normalizeSession(legacySession), updatedAt: Date.now() }]
    } catch { }
    return []
}
const choices = ['#F16B4F', '#497F78', '#D6A34B', '#6461A8']
const questionTypes = [
    ['mcq', 'Multiple choice (MCQ)'],
    ['msq', 'Multiple select (MSQ)'],
    ['fill', 'Fill in the blank'],
    ['number', 'Number only'],
    ['text', 'Text response'],
    ['dropdown', 'Dropdown'],
]
const optionQuestionTypes = new Set(['mcq', 'msq', 'dropdown'])
const pollType = (poll) => poll?.type || 'mcq'

function hasCorrectAnswer(poll) {
    if (pollType(poll) === 'msq') return asArray(poll.correctIndices).length > 0
    if (['fill', 'number', 'text'].includes(pollType(poll))) return Boolean(String(poll.correctAnswer ?? '').trim())
    return poll.correctIndex !== null && poll.correctIndex !== undefined
}

function answerIsCorrect(poll, answer) {
    if (!hasCorrectAnswer(poll)) return false
    const type = pollType(poll)
    if (type === 'msq') {
        const expected = asArray(poll.correctIndices).map(Number).sort((a, b) => a - b)
        const received = asArray(answer).map(Number).sort((a, b) => a - b)
        return expected.length === received.length && expected.every((value, index) => value === received[index])
    }
    if (type === 'number') return Number(answer) === Number(poll.correctAnswer)
    if (type === 'fill' || type === 'text') return String(answer).trim().toLowerCase() === String(poll.correctAnswer).trim().toLowerCase()
    return Number(answer) === Number(poll.correctIndex)
}

const starterSession = {
    title: 'The future of better meetings',
    deck: { name: 'The future of better meetings', type: 'sample', slides: 12 },
    activeSlide: 4,
    activePollId: 'poll-1',
    status: 'live',
    polls: [{
        id: 'poll-1', slideStart: 4, slideEnd: 4,
        type: 'mcq',
        question: 'What makes a meeting worth showing up for?',
        options: ['A clear decision to make', 'Time to share ideas', 'A useful update', 'Honestly? The snacks'],
        correctIndex: null, revealCorrect: false, revealAfterAll: false, responses: {},
    }],
    participants: {},
}

const asArray = (value) => value ? (Array.isArray(value) ? value : Object.values(value)) : []
const orderedPolls = (value) => asArray(value).map((poll, index) => ({ poll, index })).sort((left, right) => (Number(left.poll?.slideStart) || 0) - (Number(right.poll?.slideStart) || 0) || left.index - right.index).map(({ poll }) => poll)
const makeId = () => Math.random().toString(36).slice(2, 10)
const uniquePollId = (polls) => {
    const usedIds = new Set(asArray(polls).map((poll) => poll?.id).filter(Boolean))
    let id
    do { id = `poll-${makeId()}` } while (usedIds.has(id))
    return id
}
const normalizeSession = (session) => {
    if (!session || typeof session !== 'object') return session
    const seenIds = new Set()
    const rawPollEntries = session.polls && typeof session.polls === 'object' ? Object.entries(session.polls) : []
    const knownPolls = rawPollEntries.map(([, poll]) => poll).filter((poll) => poll && typeof poll === 'object' && (poll.id || poll.question || poll.options || poll.slideStart !== undefined))
    const responseFragments = new Map(rawPollEntries.filter(([key, poll]) => poll && typeof poll === 'object' && !poll.id && poll.responses && key.startsWith('poll-')).map(([key, poll]) => [key, poll.responses]))
    const polls = knownPolls.map((poll, index) => {
        if (!poll || typeof poll !== 'object') return poll
        const originalId = poll.id
        let id = originalId || `poll-${index + 1}`
        const duplicate = seenIds.has(id)
        if (duplicate) {
            const baseId = id
            let suffix = 1
            do { id = `${baseId}-copy-${suffix++}` } while (seenIds.has(id))
        }
        seenIds.add(id)
        const normalizedPoll = { ...poll, ...(responseFragments.has(id) ? { responses: { ...(poll.responses || {}), ...responseFragments.get(id) } } : {}), type: poll.type || 'mcq', options: asArray(poll.options) }
        return id === originalId && normalizedPoll.type === poll.type && normalizedPoll.options === poll.options && !responseFragments.has(id)
            ? poll
            : { ...normalizedPoll, id, ...(duplicate ? { responses: {} } : {}) }
    })
    return { ...session, polls }
}
const hasDuplicatePollIds = (session) => {
    const seenIds = new Set()
    return asArray(session?.polls).some((poll) => {
        if (!poll?.id || seenIds.has(poll.id)) return true
        seenIds.add(poll.id)
        return false
    })
}
const audienceUrl = (authCode) => {
    const url = new URL(window.location.pathname, window.location.origin)
    url.searchParams.set('code', authCode)
    return url.toString()
}

function App() {
    const params = new URLSearchParams(window.location.search)
    const authCode = params.get('code')
    if (authCode) return <AudienceView authCode={authCode} />
    if (params.get('join') === '1') return <JoinRoom />
    return <AuthGate />
}

function AuthGate() {
    const config = useMemo(() => readFirebaseConfig(), [])
    const services = useMemo(() => {
        if (!config?.apiKey || !config?.authDomain || !config?.projectId || !config?.databaseURL) return null
        try { return connectFirebase(config) } catch { return null }
    }, [config])
    const [user, setUser] = useState(null)
    const [authChecked, setAuthChecked] = useState(false)
    const [demoMode, setDemoMode] = useState(() => sessionStorage.getItem('slideo-local-demo-auth') === '1')

    useEffect(() => {
        if (!services) { setAuthChecked(true); return undefined }
        return onAuthStateChanged(services.auth, (currentUser) => {
            setUser(currentUser)
            setAuthChecked(true)
        })
    }, [services])

    function continueDemo() {
        sessionStorage.setItem('slideo-local-demo-auth', '1')
        setDemoMode(true)
    }

    if (demoMode) return <Presenter demoMode onSignOut={() => { sessionStorage.removeItem('slideo-local-demo-auth'); setDemoMode(false) }} />
    if (!services || (authChecked && !user)) return <AuthScreen services={services} onContinueDemo={!services ? continueDemo : null} />
    if (!authChecked) return <div className="auth-loading"><LoaderCircle className="spin" size={22} /><span>Checking your sign-in…</span></div>
    return <Presenter user={user} onSignOut={() => signOut(services.auth)} />
}

function AuthScreen({ services, onContinueDemo }) {
    const [mode, setMode] = useState('login')
    const [displayName, setDisplayName] = useState('')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)

    function explainAuthError(authError) {
        const knownErrors = {
            'auth/invalid-credential': 'Email or password is incorrect.',
            'auth/email-already-in-use': 'An account already exists for this email.',
            'auth/weak-password': 'Use a password with at least 6 characters.',
            'auth/invalid-email': 'Enter a valid email address.',
            'auth/popup-closed-by-user': 'The Google sign-in window was closed.',
            'auth/unauthorized-domain': 'Add this app domain in Firebase Authentication settings.',
            'auth/operation-not-allowed': 'Enable this sign-in method in Firebase Authentication.',
        }
        return knownErrors[authError.code] || authError.message || 'Sign-in failed. Please try again.'
    }

    async function submit(event) {
        event.preventDefault()
        setError('')
        if (mode === 'signup' && !displayName.trim()) { setError('Enter your name to create an account.'); return }
        if (mode === 'signup' && password !== confirmPassword) { setError('Your passwords do not match.'); return }
        if (!services) { setError('Add Firebase configuration to enable account sign-in.'); return }
        setBusy(true)
        try {
            if (mode === 'signup') {
                const credential = await createUserWithEmailAndPassword(services.auth, email, password)
                await updateProfile(credential.user, { displayName: displayName.trim() })
            }
            else await signInWithEmailAndPassword(services.auth, email, password)
        } catch (authError) { setError(explainAuthError(authError)) }
        finally { setBusy(false) }
    }

    async function continueWithGoogle() {
        if (!services) { setError('Add Firebase configuration to enable Google sign-in.'); return }
        setError('')
        setBusy(true)
        try { await signInWithPopup(services.auth, new GoogleAuthProvider()) }
        catch (authError) { setError(explainAuthError(authError)) }
        finally { setBusy(false) }
    }

    return (
        <div className="auth-shell">
            <header className="auth-topbar">
                <a className="brand" href="/"><span className="brand-mark"><span /></span><span>slideo</span></a>
                <a className="join-room-link" href="/?join=1"><KeyRound size={14} /><span>Join with room code</span></a>
            </header>
            <main className="auth-main">
                <div className="auth-intro">
                    <span className="eyebrow"><span className="eyebrow-line" />PRESENTER ACCESS</span>
                    <h1>Good ideas<br /><span>need a room.</span></h1>
                    <p>Sign in to prepare your slides, shape a question, and bring your audience into the conversation.</p>
                    <div className="auth-art" aria-hidden="true"><span className="auth-art-counter">01 / 03</span><span className="auth-art-rule" /><span className="auth-art-swatch" /><span className="auth-art-caption">PRESENT / ASK / LISTEN</span></div>
                </div>
                <section className="auth-panel" aria-labelledby="auth-title">
                    <div className="auth-panel-heading"><span className="auth-lock"><LockKeyhole size={16} /></span><div><h2 id="auth-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2><p>{mode === 'login' ? 'Sign in to your presenter workspace.' : 'Set up your presenter workspace.'}</p></div></div>
                    <div className="auth-tabs" role="tablist" aria-label="Account access">
                        <button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError('') }}>Log in</button>
                        <button role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError('') }}>Sign up</button>
                    </div>
                    <button className="google-button" type="button" onClick={continueWithGoogle} disabled={busy || !services}><span className="google-g">G</span>Continue with Google</button>
                    <div className="auth-separator"><span>or continue with email</span></div>
                    <form className="auth-form" onSubmit={submit}>
                        {mode === 'signup' && <><label htmlFor="auth-name">Your name</label><input id="auth-name" type="text" autoComplete="name" maxLength={80} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Name shown to your audience" /></>}
                        <label htmlFor="auth-email">Email address</label>
                        <input id="auth-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
                        <label htmlFor="auth-password">Password</label>
                        <input id="auth-password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" />
                        {mode === 'signup' && <><label htmlFor="auth-confirm-password">Confirm password</label><input id="auth-confirm-password" type="password" autoComplete="new-password" minLength={6} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Enter your password again" /></>}
                        {error && <div className="auth-error" role="alert">{error}</div>}
                        {!services && <div className="auth-config-note">Firebase is not configured. Add values to `.env` and restart Vite, or continue with the local demo.</div>}
                        <button className="auth-submit" type="submit" disabled={busy || !services}>{busy ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}{mode === 'login' ? 'Log in' : 'Create account'}<ArrowRight size={15} /></button>
                    </form>
                    {onContinueDemo && <button className="demo-access-button" onClick={onContinueDemo}>Continue in local demo</button>}
                    <p className="auth-footnote">Joining a presentation? <a href="/?join=1">Enter its room code</a></p>
                </section>
            </main>
        </div>
    )
}

function JoinRoom() {
    const [authCode, setAuthCode] = useState('')
    const [error, setError] = useState('')

    function join(event) {
        event.preventDefault()
        const normalized = authCode.toUpperCase().replace(/[^A-Z0-9]/g, '')
        if (normalized.length !== 8) {
            setError('Enter the 8-character room code from your presenter.')
            return
        }
        window.location.assign(audienceUrl(normalized))
    }

    return (
        <div className="audience-shell join-shell">
            <header className="audience-topbar">
                <a className="brand" href="/"><span className="brand-mark"><span /></span><span>slideo</span></a>
                <span className="join-header-label">JOIN A PRESENTATION</span>
            </header>
            <main className="join-main">
                <span className="eyebrow"><span className="eyebrow-line" />ROOM ACCESS</span>
                <h1>Step into<br /><span>the conversation.</span></h1>
                <p>Enter the room code shared by your presenter.</p>
                <form className="join-form" onSubmit={join}>
                    <label htmlFor="room-code">8-CHARACTER ROOM CODE</label>
                    <input id="room-code" autoComplete="one-time-code" autoCapitalize="characters" maxLength={8} value={authCode} onChange={(event) => { setAuthCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); setError('') }} placeholder="e.g. 7KQ4M9TX" />
                    {error && <span className="join-error" role="alert">{error}</span>}
                    <button className="launch-button" type="submit" disabled={authCode.length !== 8}>Join room <ArrowRight size={15} /></button>
                </form>
                <a className="join-presenter-link" href="/">Back to presenter studio</a>
            </main>
        </div>
    )
}

function Presenter({ user, onSignOut, demoMode = false }) {
    const draftStorageKey = user?.uid ? `${localKey}:${user.uid}` : localKey
    const workspaceStorageKey = `${localKey}:workspaces:${user?.uid || (demoMode ? 'demo' : 'local')}`
    const [workspaces, setWorkspaces] = useState(() => readStoredWorkspaces(workspaceStorageKey, draftStorageKey))
    const [activeWorkspaceId, setActiveWorkspaceId] = useState(null)
    const [workspacePageOpen, setWorkspacePageOpen] = useState(true)
    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    const [session, setSession] = useState(starterSession)
    const [services, setServices] = useState(null)
    const [remoteId, setRemoteId] = useState(null)
    const [shareUrl, setShareUrl] = useState('')
    const [busy, setBusy] = useState(false)
    const [deckUploading, setDeckUploading] = useState(false)
    const [draftReady, setDraftReady] = useState(!user?.uid || demoMode)
    const [notice, setNotice] = useState('')
    const [profileMenuOpen, setProfileMenuOpen] = useState(false)
    const profileMenuRef = useRef(null)
    const [editingPoll, setEditingPoll] = useState(null)
    const [selectedPollId, setSelectedPollId] = useState(session.activePollId)
    const [deckPreview, setDeckPreview] = useState('')
    const [deckFile, setDeckFile] = useState(null)
    const [actualSlideCount, setActualSlideCount] = useState(null)
    const [slideNumber, setSlideNumber] = useState(session.activeSlide || 1)
    const [isPresenting, setIsPresenting] = useState(false)
    const [isFullscreen, setIsFullscreen] = useState(false)
    const [allResponsesOpen, setAllResponsesOpen] = useState(false)
    const workspaceUrlRestoreRef = useRef(false)

    useEffect(() => {
        localStorage.setItem(workspaceStorageKey, JSON.stringify({ workspaces }))
    }, [workspaceStorageKey, workspaces])

    useEffect(() => {
        if (!activeWorkspaceId) return
        setWorkspaces((current) => current.map((workspace) => workspace.id === activeWorkspaceId
            ? { ...workspace, session, activeSessionId: remoteId, shareUrl, updatedAt: Date.now() }
            : workspace))
        if (!remoteId) localStorage.setItem(localKey, JSON.stringify(session))
    }, [activeWorkspaceId, session, remoteId, shareUrl])

    useEffect(() => {
        function syncFullscreenState() {
            setIsFullscreen(Boolean(document.fullscreenElement))
        }
        document.addEventListener('fullscreenchange', syncFullscreenState)
        return () => document.removeEventListener('fullscreenchange', syncFullscreenState)
    }, [])

    useEffect(() => {
        if (!actualSlideCount) return
        setSession((current) => current.deck?.slides === actualSlideCount
            ? current
            : { ...current, deck: { ...current.deck, slides: actualSlideCount } })
    }, [actualSlideCount])

    useEffect(() => {
        if (!profileMenuOpen) return undefined
        function closeMenu(event) {
            if (!profileMenuRef.current?.contains(event.target)) setProfileMenuOpen(false)
        }
        function handleMenuKey(event) {
            if (event.key === 'Escape') setProfileMenuOpen(false)
        }
        document.addEventListener('pointerdown', closeMenu)
        document.addEventListener('keydown', handleMenuKey)
        return () => {
            document.removeEventListener('pointerdown', closeMenu)
            document.removeEventListener('keydown', handleMenuKey)
        }
    }, [profileMenuOpen])

    useEffect(() => {
        const config = readFirebaseConfig()
        if (config?.apiKey && config?.databaseURL) {
            try { setServices(connectFirebase(config)) } catch { setServices(null) }
        }
    }, [])

    useEffect(() => {
        if (!user?.uid || demoMode) { setDraftReady(true); return undefined }
        if (!services) return undefined
        let active = true
        setDraftReady(false)
        loadPresenterDraft(services.database, user.uid).then((draft) => {
            if (!active) return
            if (Array.isArray(draft?.workspaces)) {
                const restoredWorkspaces = draft.workspaces.map((workspace) => ({ ...workspace, session: normalizeSession(workspace.session || starterSession) }))
                setWorkspaces(restoredWorkspaces)
                localStorage.setItem(workspaceStorageKey, JSON.stringify({ workspaces: restoredWorkspaces }))
            } else if (draft?.session) {
                const legacyWorkspace = { id: 'workspace-legacy', name: 'Untitled', session: normalizeSession(draft.session), activeSessionId: draft.activeSessionId || null, updatedAt: Date.now() }
                setWorkspaces([legacyWorkspace])
                localStorage.setItem(workspaceStorageKey, JSON.stringify({ workspaces: [legacyWorkspace] }))
            }
        }).catch(showError).finally(() => { if (active) setDraftReady(true) })
        return () => { active = false }
    }, [services, user?.uid, demoMode])

    useEffect(() => {
        if (!draftReady || activeWorkspaceId || workspaceUrlRestoreRef.current) return
        const workspaceId = new URLSearchParams(window.location.search).get('workspace')
        if (!workspaceId) return
        const workspace = workspaces.find((item) => item.id === workspaceId)
        if (!workspace) return
        workspaceUrlRestoreRef.current = true
        openWorkspace(workspace)
    }, [draftReady, activeWorkspaceId, workspaces])

    useEffect(() => {
        if (!services || !user?.uid || demoMode || !draftReady) return undefined
        const timer = window.setTimeout(() => savePresenterDraft(services.database, user.uid, { workspaces }).catch(showError), 500)
        return () => window.clearTimeout(timer)
    }, [services, user?.uid, demoMode, draftReady, workspaces])

    useEffect(() => {
        if (!services || !user?.uid || demoMode || !deckFile || session.deck?.url || session.deck?.databasePath) return undefined
        let active = true
        setDeckUploading(true)
        uploadDeck(services.database, services.storage, user.uid, deckFile).then((deckReference) => {
            if (!active) return
            const deck = { ...session.deck, ...deckReference }
            setSession((current) => ({ ...current, deck }))
            if (remoteId) patchSession(services.database, remoteId, { deck }).catch(showError)
            setNotice('Deck saved to your account.')
        }).catch(showError).finally(() => { if (active) setDeckUploading(false) })
        return () => { active = false }
    }, [services, user?.uid, demoMode, deckFile, remoteId])

    useEffect(() => {
        if (!services || !remoteId) return undefined
        return subscribeSession(services.database, remoteId, (data) => {
            if (!data) return
            const normalizedSession = normalizeSession(data)
            setSession(normalizedSession)
            if (data.polls && !Array.isArray(data.polls) && Object.keys(data.polls).some((key) => /^\d+$/.test(key))) {
                patchSession(services.database, remoteId, { polls: normalizedSession.polls }).catch(showError)
            }
            if (hasDuplicatePollIds(data)) patchSession(services.database, remoteId, { polls: normalizedSession.polls }).catch(showError)
        })
    }, [services, remoteId])

    useEffect(() => {
        if (remoteId) return undefined
        function receiveLocalRoomUpdate(event) {
            if (event.key !== localKey || !event.newValue) return
            try {
                const updated = normalizeSession(JSON.parse(event.newValue))
                if (updated?.authCode === session.authCode) setSession(updated)
            } catch { }
        }
        window.addEventListener('storage', receiveLocalRoomUpdate)
        return () => window.removeEventListener('storage', receiveLocalRoomUpdate)
    }, [remoteId, session.authCode])

    useEffect(() => {
        const poll = asArray(session.polls).find((item) => item.id === selectedPollId)
        if (poll) setEditingPoll({ ...poll, options: [...(poll.options || [])] })
    }, [selectedPollId, session.polls])

    const polls = useMemo(() => orderedPolls(session.polls), [session.polls])
    const voteCount = polls.reduce((sum, poll) => sum + Object.keys(poll.responses || {}).length, 0)
    const roomShareUrl = session.authCode ? audienceUrl(session.authCode) : shareUrl

    function setSessionValue(key, value) {
        setSession((current) => ({ ...current, [key]: value }))
        if (services && remoteId) patchSession(services.database, remoteId, { [key]: value }).catch(showError)
    }

    function showError(error) {
        setNotice(error?.message || 'Something went wrong. Check your .env values and Firebase rules.')
        window.setTimeout(() => setNotice(''), 5000)
    }

    function updatePoll(pollId, patch) {
        const next = polls.map((poll) => poll.id === pollId ? { ...poll, ...patch } : poll)
        setSession((current) => ({ ...current, polls: next }))
        if (services && remoteId) patchPoll(services.database, remoteId, pollId, patch).catch(showError)
    }

    function handleDeckUpload(file) {
        if (!file) return
        setDeckFile(file)
        setActualSlideCount(null)
        const extension = file.name.split('.').pop().toLowerCase()
        const type = extension === 'html' || extension === 'htm' ? 'html' : 'pptx'
        const preview = type === 'html' ? URL.createObjectURL(file) : ''
        setDeckPreview(preview)
        setSession((current) => ({
            ...current,
            title: current.title === starterSession.title ? file.name.replace(/\.[^.]+$/, '') : current.title,
            deck: { name: file.name, type, slides: current.deck?.slides || 12 },
        }))
        setNotice(type === 'html' ? 'HTML presentation ready to preview.' : 'PowerPoint added. Enter the slide count to map your polls.')
        window.setTimeout(() => setNotice(''), 3500)
    }

    function activatePresentationPoll(poll) {
        if (!poll) return
        const patch = { activePollId: poll.id }
        setSession((current) => ({ ...current, ...patch }))
        if (services && remoteId) patchSession(services.database, remoteId, patch).catch(showError)
    }

    if (isPresenting) return <PresentationView
        session={session}
        shareUrl={roomShareUrl}
        slideNumber={slideNumber}
        slideCount={actualSlideCount || session.deck?.slides || 1}
        deckFile={deckFile}
        deckPreview={deckPreview}
        database={services?.database}
        isFullscreen={isFullscreen}
        onSlideChange={changeSlide}
        onSlideCount={setActualSlideCount}
        onSelectPoll={activatePresentationPoll}
        onAddQuestion={addPoll}
        onToggleResults={togglePublicResults}
        onToggleFullscreen={toggleFullscreen}
        onStop={stopSession}
        editingPoll={editingPoll}
        onEditingPollChange={setEditingPoll}
        onSavePoll={savePoll}
        onDeletePoll={deletePoll}
        onApproveJoinRequest={(request) => approveJoinRequest(services.database, remoteId, request.uid, request.name).catch(showError)}
        onRejectJoinRequest={(request) => rejectJoinRequest(services.database, remoteId, request.uid).catch(showError)}
    />

    async function launchSession() {
        const fullscreenRequest = document.documentElement.requestFullscreen?.().catch(() => {})
        setBusy(true)
        try {
            const remoteSession = Boolean(services && user?.uid && !demoMode)
            let deck = session.deck
            if (remoteSession && deckFile && !deck?.url && !deck?.databasePath) {
                deck = { ...deck, ...await uploadDeck(services.database, services.storage, user.uid, deckFile) }
            }
            let payload = { ...session, deck, status: 'live', resultsVisible: false }
            if (remoteSession) {
                const { id, authCode } = await createRemoteSession(services.database, payload, activeWorkspaceId)
                payload = { ...payload, authCode }
                setRemoteId(id)
                localStorage.setItem('slideo-presenter-session', id)
                localStorage.setItem('slideo-presenter-owner', user.uid)
                setSession(payload)
                setIsPresenting(true)
                localStorage.setItem('slideo-presenter-code', authCode)
                const link = audienceUrl(authCode)
                setShareUrl(link)
                await navigator.clipboard?.writeText(link)
                setNotice('Live session created. Link and room code copied.')
            } else {
                payload = { ...payload, authCode: payload.authCode || generateRoomCode() }
                localStorage.setItem(localKey, JSON.stringify(payload))
                localStorage.removeItem('slideo-presenter-session')
                localStorage.removeItem('slideo-presenter-owner')
                localStorage.setItem('slideo-presenter-code', payload.authCode)
                setRemoteId(null)
                setSession(payload)
                setIsPresenting(true)
                const link = audienceUrl(payload.authCode)
                setShareUrl(link)
                await navigator.clipboard?.writeText(link).catch(() => { })
                setNotice(`Demo room code: ${payload.authCode}. Add Firebase for other devices.`)
            }
        } catch (error) { showError(error) }
        finally { setBusy(false); await fullscreenRequest; window.setTimeout(() => setNotice(''), 5000) }
    }

    function savePoll() {
        if (!editingPoll?.id || !polls.some((poll) => poll.id === editingPoll.id)) {
            setNotice('Use Add poll to create a question tile, then save your edits.')
            window.setTimeout(() => setNotice(''), 3500)
            return false
        }
        const type = pollType(editingPoll)
        const options = asArray(editingPoll?.options).map((item) => String(item).trim()).filter(Boolean)
        if (!editingPoll?.question.trim() || (optionQuestionTypes.has(type) && options.length < 2)) {
            setNotice(optionQuestionTypes.has(type) ? 'Add a question and at least two answer options.' : 'Add a question before saving this poll.')
            window.setTimeout(() => setNotice(''), 3500)
            return false
        }
        const cleaned = { ...editingPoll, type, options }
        updatePoll(cleaned.id, cleaned)
        setSelectedPollId(cleaned.id)
        setNotice('Poll saved.')
        window.setTimeout(() => setNotice(''), 2500)
        return true
    }

    function addPoll() {
        const currentSlide = Math.max(1, Number(slideNumber) || 1)
        const poll = {
            id: uniquePollId(polls), slideStart: currentSlide, slideEnd: currentSlide,
            type: 'mcq', question: '', options: ['', '', '', ''], correctIndex: null, correctIndices: [], correctAnswer: '',
            revealCorrect: false, revealAfterAll: true, responses: {},
        }
        const next = [...polls, poll]
        const patch = { polls: next, activeSlide: poll.slideStart, activePollId: poll.id }
        setSession((current) => ({ ...current, ...patch }))
        if (services && remoteId) patchSession(services.database, remoteId, patch).catch(showError)
        setSlideNumber(poll.slideStart)
        setSelectedPollId(poll.id)
        setEditingPoll(poll)
    }

    function openPoll(poll) {
        const slide = Number(poll.slideStart) || 1
        setSelectedPollId(poll.id)
        setEditingPoll({ ...poll, type: pollType(poll), options: [...asArray(poll.options)] })
        setSlideNumber(slide)
        const patch = { activeSlide: slide, activePollId: poll.id }
        setSession((current) => ({ ...current, ...patch }))
        if (services && remoteId) patchSession(services.database, remoteId, patch).catch(showError)
    }

    function deletePoll(pollId, { confirmDelete = true } = {}) {
        const pollToDelete = polls.find((poll) => poll.id === pollId)
        if (!pollToDelete || (confirmDelete && !window.confirm('Delete this question and its responses?'))) return false
        const nextPolls = polls.filter((poll) => poll.id !== pollId)
        const nextActivePoll = nextPolls.find((poll) => poll.id === session.activePollId)
            || nextPolls.find((poll) => slideNumber >= poll.slideStart && slideNumber <= poll.slideEnd)
            || nextPolls[0]
        const patch = { polls: nextPolls, activePollId: nextActivePoll?.id || null }
        setSession((current) => ({ ...current, ...patch }))
        if (services && remoteId) patchSession(services.database, remoteId, patch).catch(showError)
        if (selectedPollId === pollId) {
            setSelectedPollId(nextActivePoll?.id || null)
            setEditingPoll(nextActivePoll ? { ...nextActivePoll, options: [...asArray(nextActivePoll.options)] } : null)
        }
        return true
    }

    function toggleCorrectOption(index) {
        if (pollType(editingPoll) === 'msq') {
            const selected = asArray(editingPoll.correctIndices)
            const correctIndices = selected.includes(index) ? selected.filter((item) => item !== index) : [...selected, index]
            setEditingPoll({ ...editingPoll, correctIndices })
        } else {
            setEditingPoll({ ...editingPoll, correctIndex: editingPoll.correctIndex === index ? null : index })
        }
    }

    function changeSlide(value) {
        const maxSlide = actualSlideCount || Number(session.deck?.slides) || 9999
        const next = Math.max(1, Math.min(maxSlide, Number(value) || 1))
        setSlideNumber(next)
        const activePoll = polls.find((poll) => next >= Number(poll.slideStart) && next <= Number(poll.slideEnd))
        const patch = { activeSlide: next, activePollId: activePoll?.id || null }
        setSession((current) => ({ ...current, ...patch }))
        if (services && remoteId) patchSession(services.database, remoteId, patch).catch(showError)
        if (activePoll) setSelectedPollId(activePoll.id)
    }

    async function copyLink() {
        const authCode = session.authCode || localStorage.getItem('slideo-presenter-code')
        if (!authCode) {
            setNotice('Start a session to generate a room code.')
            window.setTimeout(() => setNotice(''), 3500)
            return
        }
        const link = audienceUrl(authCode)
        setShareUrl(link)
        try { await navigator.clipboard.writeText(link); setNotice('Audience link copied.') }
        catch { setNotice(link) }
        window.setTimeout(() => setNotice(''), 4500)
    }

    async function stopSession() {
        if (!shareUrl || session.status === 'ended') return
        if (!window.confirm('Stop presenting? Audience members will no longer be able to vote.')) return
        const endedState = { status: 'ended', endedAt: Date.now() }
        try {
            if (services && remoteId) await patchSession(services.database, remoteId, endedState)
            setSession((current) => ({ ...current, ...endedState }))
            setIsPresenting(false)
            if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
            setNotice('Session ended. Audience voting is closed.')
        } catch (error) { showError(error) }
        window.setTimeout(() => setNotice(''), 4500)
    }

    function togglePublicResults() {
        const patch = { resultsVisible: !session.resultsVisible }
        setSession((current) => ({ ...current, ...patch }))
        if (services && remoteId) patchSession(services.database, remoteId, patch).catch(showError)
    }

    function toggleFullscreen() {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
        else document.documentElement.requestFullscreen?.().catch(() => {})
    }

    async function openWorkspace(workspace) {
        const previousSession = normalizeSession(workspace.session || starterSession)
        let authCode = previousSession.authCode || generateRoomCode()
        if (!previousSession.authCode && previousSession.status === 'live' && workspace.activeSessionId && services && !demoMode) {
            try {
                authCode = await reserveRoomCode(services.database, workspace.activeSessionId, authCode)
                await patchSession(services.database, workspace.activeSessionId, { authCode })
            } catch (error) {
                showError(error)
                return
            }
        }
        setActiveWorkspaceId(workspace.id)
        setWorkspacePageOpen(false)
        const params = new URLSearchParams(window.location.search)
        params.set('workspace', workspace.id)
        window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`)
        const restoredSession = { ...previousSession, authCode }
        const nextShareUrl = audienceUrl(authCode)
        setWorkspaces((current) => current.map((item) => item.id === workspace.id
            ? { ...item, session: restoredSession, shareUrl: nextShareUrl, updatedAt: Date.now() }
            : item))
        setSession(restoredSession)
        setRemoteId(workspace.activeSessionId || null)
        setShareUrl(nextShareUrl)
        setSlideNumber(restoredSession.activeSlide || 1)
        setSelectedPollId(restoredSession.activePollId || asArray(restoredSession.polls)[0]?.id || null)
        setDeckFile(null)
        setDeckPreview('')
        setActualSlideCount(null)
    }

    function createWorkspace() {
        const name = window.prompt('Name your new workspace')?.trim()
        if (!name) return
        const authCode = generateRoomCode()
        const workspace = {
            id: makeWorkspaceId(), name, updatedAt: Date.now(), activeSessionId: null, shareUrl: audienceUrl(authCode),
            session: { ...starterSession, title: name, deck: { name, type: 'sample', slides: 12 }, activeSlide: 1, activePollId: null, status: 'draft', authCode, polls: [], participants: {} },
        }
        setWorkspaces((current) => [workspace, ...current])
        openWorkspace(workspace)
    }

    function renameWorkspace(workspace) {
        const name = window.prompt('Rename workspace', workspace.name === 'Untitled' ? '' : workspace.name)?.trim()
        if (!name) return
        setWorkspaces((current) => current.map((item) => item.id === workspace.id ? { ...item, name, updatedAt: Date.now() } : item))
    }

    async function deleteWorkspace(workspace) {
        const name = workspace.name || 'Untitled'
        if (!window.confirm(`Delete “${name}” and all its questions, responses, deck file, live sessions, and room codes? This cannot be undone.`)) return
        setBusy(true)
        try {
            if (services && user?.uid && !demoMode) {
                await deleteWorkspaceData(services.database, services.storage, user.uid, workspace)
            } else {
                try {
                    const localSession = JSON.parse(localStorage.getItem(localKey))
                    if (localSession?.authCode === workspace.session?.authCode) localStorage.removeItem(localKey)
                } catch { }
            }
            if (localStorage.getItem('slideo-presenter-code') === workspace.session?.authCode) {
                localStorage.removeItem('slideo-presenter-code')
                localStorage.removeItem('slideo-presenter-session')
                localStorage.removeItem('slideo-presenter-owner')
            }
            const nextWorkspaces = workspaces.filter((item) => item.id !== workspace.id)
            setWorkspaces(nextWorkspaces)
            if (user?.uid && !demoMode) await savePresenterDraft(services.database, user.uid, { workspaces: nextWorkspaces })
            if (activeWorkspaceId === workspace.id) {
                setActiveWorkspaceId(null)
                setRemoteId(null)
                setShareUrl('')
                setDeckFile(null)
                setDeckPreview('')
                setSession(starterSession)
                setWorkspacePageOpen(true)
                const params = new URLSearchParams(window.location.search)
                params.delete('workspace')
                const query = params.toString()
                window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
            }
            setNotice(`Deleted “${name}” and its related data.`)
            window.setTimeout(() => setNotice(''), 3500)
        } catch (error) { showError(error) }
        finally { setBusy(false) }
    }

    function returnToWorkspaceList() {
        setWorkspacePageOpen(true)
        const params = new URLSearchParams(window.location.search)
        params.delete('workspace')
        const query = params.toString()
        window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }

    async function resetWorkspaceRoomCode() {
        const nextCode = generateRoomCode()
        try {
            let authCode = nextCode
            if (session.status === 'live' && remoteId && services && !demoMode) {
                authCode = await reserveRoomCode(services.database, remoteId, nextCode, session.authCode)
                await patchSession(services.database, remoteId, { authCode })
            }
            const nextLink = audienceUrl(authCode)
            setSession((current) => ({ ...current, authCode }))
            setShareUrl(nextLink)
            localStorage.setItem('slideo-presenter-code', authCode)
        } catch (error) { showError(error) }
    }

    if (isPresenting) return <PresentationView
        session={session}
        shareUrl={roomShareUrl}
        slideNumber={slideNumber}
        slideCount={actualSlideCount || session.deck?.slides || 1}
        deckFile={deckFile}
        deckPreview={deckPreview}
        database={services?.database}
        isFullscreen={isFullscreen}
        onSlideChange={changeSlide}
        onSlideCount={setActualSlideCount}
        onToggleResults={togglePublicResults}
        onToggleFullscreen={toggleFullscreen}
        onStop={stopSession}
        editingPoll={editingPoll}
        onEditingPollChange={setEditingPoll}
        onSavePoll={savePoll}
    />

    if (!draftReady) return <div className="auth-loading"><LoaderCircle className="spin" size={22} /><span>Loading your workspaces…</span></div>

    if (workspacePageOpen || !activeWorkspaceId) return <WorkspaceHome
        workspaces={workspaces}
        user={user}
        demoMode={demoMode}
        onOpen={openWorkspace}
        onCreate={createWorkspace}
        onRename={renameWorkspace}
        onDelete={deleteWorkspace}
        onSignOut={onSignOut}
    />

    return (
        <div className="app-shell">
            <header className="topbar">
                <a className="brand" href="/" aria-label="Slideo home"><span className="brand-mark"><span /></span><span>slideo</span></a>
                <div className="topbar-center"><button className="workspace-back-link" onClick={returnToWorkspaceList}><ArrowLeft size={14} /> All workspaces</button><span className="crumb-slash">/</span><span>{activeWorkspace?.name || 'Presenter studio'}</span></div>
                <div className="topbar-actions">
                    <a className="join-room-link" href="/?join=1"><KeyRound size={14} /><span>Join a room</span></a>
                    <div className="profile-menu-wrap" ref={profileMenuRef}>
                        <button className="avatar-button" aria-label="Open profile menu" aria-haspopup="menu" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen((open) => !open)}><span className="avatar">{demoMode ? 'D' : (user?.displayName?.[0] || user?.email?.[0] || 'S').toUpperCase()}</span></button>
                        {profileMenuOpen && <div className="profile-menu" role="menu">
                            <div className="profile-menu-identity"><strong>{demoMode ? 'Local demo' : user?.displayName || 'Presenter'}</strong><span>{demoMode ? 'This browser only' : user?.email || 'Signed in'}</span></div>
                            <div className="profile-menu-divider" />
                            <button className="profile-menu-item" role="menuitem" onClick={() => { setProfileMenuOpen(false); onSignOut() }}><LogOut size={14} />{demoMode ? 'Exit demo' : 'Sign out'}</button>
                        </div>}
                    </div>
                </div>
            </header>

            <main className="studio">
                <section className="workspace-heading">
                    <div>
                        <div className="eyebrow"><span className="eyebrow-line" />PRESENTATION WORKSPACE</div>
                        <h1>Make room<br /><span>for every voice.</span></h1>
                        <p className="heading-copy">A good presentation starts a conversation.<br className="desktop-break" /> Give your audience a way into it.</p>
                    </div>
                    <div className="heading-aside">
                        <div className="session-chip"><span className={`live-pulse ${session.status === 'ended' ? 'ended' : ''}`} />{session.status === 'ended' ? 'SESSION ENDED' : session.status === 'live' ? 'SESSION LIVE' : 'SESSION READY'}</div>
                        <div className="stats-row">
                            <div><strong>{polls.length.toString().padStart(2, '0')}</strong><span>polls</span></div>
                            <div className="stats-divider" />
                            <div><strong>{voteCount.toString().padStart(2, '0')}</strong><span>responses</span></div>
                        </div>
                    </div>
                </section>

                <section className="responses-dashboard-launch">
                    <div className="responses-launch-icon"><BarChart3 size={18} /></div>
                    <div className="responses-launch-copy"><strong>Review audience responses</strong><span>See answers and results for every question in one place.</span></div>
                    <button className="all-responses-button" onClick={() => setAllResponsesOpen(true)}><BarChart3 size={15} /> View all responses <ArrowRight size={14} /></button>
                </section>

                <section className="studio-grid">
                    <div className="deck-column">
                        <div className="section-topline"><div><span className="section-kicker">01</span><h2>Your presentation</h2></div><label className="upload-button"><Upload size={15} /> Upload deck<input type="file" accept=".html,.htm,.ppt,.pptx" onChange={(event) => handleDeckUpload(event.target.files?.[0])} /></label></div>
                        <div className="deck-frame">
                            <div className="slide-stage">
                                {deckPreview ? <iframe title="HTML presentation preview" src={deckPreview} sandbox="allow-scripts allow-same-origin" /> : session.deck?.url ? <DeckFrame deck={session.deck} title={session.title} /> : deckFile && /\.(ppt|pptx)$/i.test(deckFile.name) ? <PptxPreview file={deckFile} deck={session.deck} slideNumber={slideNumber} onSlideCount={setActualSlideCount} /> : session.deck?.databasePath ? <PptxPreview database={services?.database} deck={session.deck} slideNumber={slideNumber} onSlideCount={setActualSlideCount} /> : <SlideArtwork title={session.title} deck={session.deck} />}
                                <div className="slide-counter"><span>SLIDE</span><input aria-label="Current slide number" type="number" min="1" max={actualSlideCount || session.deck?.slides || 9999} value={slideNumber} onChange={(event) => changeSlide(event.target.value)} /><span className="counter-slash">/</span><input aria-label="Total slide count" type="number" min="1" readOnly={Boolean(actualSlideCount)} value={actualSlideCount || session.deck?.slides || 12} onChange={(event) => setSessionValue('deck', { ...session.deck, slides: Math.max(1, Number(event.target.value) || 1) })} /></div>
                                <div className="stage-controls"><button aria-label="Previous slide" title="Previous slide" onClick={() => changeSlide(slideNumber - 1)}><ArrowLeft size={16} /></button><button aria-label="Next slide" title="Next slide" onClick={() => changeSlide(slideNumber + 1)}><ArrowRight size={16} /></button></div>
                            </div>
                            <div className="deck-meta"><div className="deck-file-icon"><Presentation size={17} /></div><div className="deck-file-copy"><strong>{session.deck?.name || 'Untitled presentation'}</strong><span>{session.deck?.type === 'sample' ? 'Sample deck · ready to customize' : `${session.deck?.type?.toUpperCase()} presentation · ${session.deck?.slides || 12} slides`}</span></div><button className="icon-button subtle" aria-label="Upload a different deck" title="Upload a different deck" onClick={() => document.querySelector('.upload-button input')?.click()}><ArrowDownToLine size={16} /></button></div>
                        <div className="slide-strip"><span className="strip-label">QUESTIONS ON</span>{polls.map((poll, index) => <div className="slide-thumb-wrap" key={`${poll.id}-${index}`}><button className={`slide-thumb ${poll.id === selectedPollId ? 'active' : ''}`} aria-label={`Edit question ${index + 1}: ${poll.question || 'Untitled question'}`} title={poll.question || 'Untitled question'} onClick={() => openPoll(poll)}><span>Q{String(index + 1).padStart(2, '0')}</span><small>slide {poll.slideStart}{poll.slideEnd !== poll.slideStart ? `–${poll.slideEnd}` : ''}</small></button><button className="delete-poll-button" title="Delete question" aria-label={`Delete question ${index + 1}`} onClick={(event) => { event.stopPropagation(); deletePoll(poll.id) }}><X size={12} /></button></div>)}<button className="add-slide-poll" onClick={addPoll}><Plus size={14} /><span>Add poll</span></button></div>
                        </div>
                        <div className="deck-footnote"><CircleHelp size={14} /><span>HTML presentations preview here. PowerPoint decks are saved in Realtime Database for audience download.</span></div>
                    </div>

                    <div className="poll-column">
                        <div className="section-topline"><div><span className="section-kicker">02</span><h2>Ask your audience</h2></div><button className="text-button" onClick={addPoll}><Plus size={15} /> New poll</button></div>
                        {editingPoll ? <div className="poll-editor">
                            <div className="editor-header"><div className="editor-label"><span className="mini-spark"><Sparkles size={13} /></span><span>QUESTION BUILDER</span></div><button className="more-button" title="Close question editor" aria-label="Close question editor" onClick={() => setEditingPoll(null)}><X size={17} /></button></div>
                            <div className="slide-association"><span>SHOW WITH SLIDE</span><div className="range-inputs"><label><span>From</span><input type="number" min="1" value={editingPoll.slideStart} onChange={(event) => setEditingPoll({ ...editingPoll, slideStart: Number(event.target.value) || 1, slideEnd: Math.max(Number(event.target.value) || 1, editingPoll.slideEnd) })} /></label><span className="range-dash">to</span><label><span>Through</span><input type="number" min={editingPoll.slideStart} value={editingPoll.slideEnd} onChange={(event) => setEditingPoll({ ...editingPoll, slideEnd: Math.max(editingPoll.slideStart, Number(event.target.value) || 1) })} /></label></div></div>
                            <label className="question-type-field"><span className="field-label">QUESTION TYPE</span><select className="question-type-select" value={pollType(editingPoll)} onChange={(event) => setEditingPoll({ ...editingPoll, type: event.target.value })}>{questionTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                            <label className="field-label" htmlFor="poll-question">YOUR QUESTION</label>
                            <textarea id="poll-question" className="question-input" rows="2" placeholder="What do you want to know?" value={editingPoll.question} onChange={(event) => setEditingPoll({ ...editingPoll, question: event.target.value })} />
                            {optionQuestionTypes.has(pollType(editingPoll)) ? <>
                                <div className="options-heading"><span className="field-label">{pollType(editingPoll) === 'dropdown' ? 'DROPDOWN OPTIONS' : 'ANSWER OPTIONS'}</span><span className="correct-hint">{pollType(editingPoll) === 'msq' ? 'Mark accepted answers' : 'Mark correct'} <Check size={12} /></span></div>
                                <div className="option-list">{asArray(editingPoll.options).map((option, index) => {
                                    const isCorrect = pollType(editingPoll) === 'msq' ? asArray(editingPoll.correctIndices).includes(index) : editingPoll.correctIndex === index
                                    return <div className={`option-row ${isCorrect ? 'is-correct' : ''}`} key={index}><span className="option-marker" style={{ '--option-color': choices[index % choices.length] }}>{String.fromCharCode(65 + index)}</span><input aria-label={`Answer option ${index + 1}`} value={option} placeholder={`Option ${String.fromCharCode(65 + index)}`} onChange={(event) => setEditingPoll({ ...editingPoll, options: editingPoll.options.map((item, optionIndex) => optionIndex === index ? event.target.value : item) })} /><button className="correct-toggle" aria-label={`Mark option ${String.fromCharCode(65 + index)} correct`} title="Mark as correct answer" onClick={() => toggleCorrectOption(index)}>{isCorrect ? <Check size={14} /> : <span />}</button></div>
                                })}</div>
                                <button className="add-option" onClick={() => setEditingPoll({ ...editingPoll, options: [...asArray(editingPoll.options), ''] })}><Plus size={14} /> Add another option</button>
                            </> : <label className="correct-answer-field"><span className="field-label">EXPECTED ANSWER (OPTIONAL)</span><input className="correct-answer-input" type={pollType(editingPoll) === 'number' ? 'number' : 'text'} step={pollType(editingPoll) === 'number' ? 'any' : undefined} value={editingPoll.correctAnswer || ''} onChange={(event) => setEditingPoll({ ...editingPoll, correctAnswer: event.target.value })} placeholder={pollType(editingPoll) === 'number' ? 'Enter the correct number' : 'Enter an accepted answer'} /></label>}
                            <div className="editor-divider" />
                            <label className="toggle-row"><span className="toggle-copy"><strong>Reveal correct answer</strong><small>Show the marked answer after results</small></span><input type="checkbox" checked={editingPoll.revealCorrect} onChange={(event) => setEditingPoll({ ...editingPoll, revealCorrect: event.target.checked })} /><span className="toggle-ui" /></label>
                            <label className="toggle-row"><span className="toggle-copy"><strong>Wait for everyone</strong><small>Hold results until all joined viewers vote</small></span><input type="checkbox" checked={editingPoll.revealAfterAll} onChange={(event) => setEditingPoll({ ...editingPoll, revealAfterAll: event.target.checked })} /><span className="toggle-ui" /></label>
                            <div className="editor-actions"><button className="save-poll" onClick={savePoll}><Check size={16} /> Save poll</button><span>Edits save to this session</span></div>
                        </div> : <div className="empty-editor"><div className="empty-icon"><FilePlus2 size={22} /></div><h3>A question changes the room.</h3><p>Add a poll to this slide, or connect one to a range of slides.</p><button className="save-poll" onClick={addPoll}><Plus size={15} /> Create a poll</button></div>}
                    </div>
                </section>

                <section className="share-bar">
                    <div className="share-mark"><Radio size={17} /></div><div className="share-copy"><strong>{roomShareUrl ? 'Your room is ready' : 'Ready to bring everyone in?'}</strong><span>{roomShareUrl ? 'Share the link or give them the room code.' : 'Open a workspace to generate a room code and link.'}</span></div>
                    {roomShareUrl && <div className="room-code-display"><span>ROOM CODE</span><strong>{session.authCode}</strong><button className="reset-room-code-button" onClick={resetWorkspaceRoomCode} title="Generate a new room code"><RefreshCw size={11} /> Reset code</button></div>}
                    {roomShareUrl && <button className="share-link" onClick={copyLink}><Link2 size={15} /><span>{roomShareUrl.replace(/^https?:\/\//, '')}</span><Copy size={14} /></button>}
                    {session.status === 'live' && <button className="stop-session-button" onClick={stopSession} disabled={busy || deckUploading}><Square size={15} /> Stop presenting</button>}
                    <button className="launch-button" onClick={session.status === 'live' ? copyLink : launchSession} disabled={busy || deckUploading}>{busy || deckUploading ? <LoaderCircle className="spin" size={16} /> : session.status === 'live' ? <Copy size={15} /> : <MonitorPlay size={16} />}{deckUploading ? 'Saving deck…' : busy ? 'Preparing…' : session.status === 'live' ? 'Copy audience link' : session.status === 'ended' ? 'Start new session' : 'Start session'}<ArrowRight size={15} /></button>
                </section>
                <section className="room-access-panel">
                    <div className="room-access-heading"><div className="room-access-icon"><LockKeyhole size={16} /></div><div><strong>Room access</strong><span>{!remoteId ? 'Start a Firebase session to manage access.' : session.accessMode === 'request' ? 'People need your approval before joining.' : 'Anyone with the room code can join.'}</span></div><select aria-label="Room access" value={session.accessMode || 'public'} disabled={!remoteId} onChange={(event) => setSessionValue('accessMode', event.target.value)}><option value="public">Public</option><option value="request">Permission required</option></select></div>
                    {session.accessMode === 'request' && <div className="room-requests"><div className="room-requests-heading"><strong>Join requests</strong><span>{Object.values(session.joinRequests || {}).filter((request) => request.status === 'pending').length} pending</span></div>
                    {Object.values(session.joinRequests || {}).filter((request) => request.status === 'pending').map((request) => <div className="join-request-row" key={request.uid}><div className="join-request-person"><span className="request-avatar">{String(request.name || 'P').trim().charAt(0).toUpperCase()}</span><span><strong>{request.name}</strong><small>{request.email || 'Signed-in participant'} · requested {new Date(request.requestedAt || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></span></div><div className="join-request-actions"><button className="approve-request" onClick={() => approveJoinRequest(services.database, remoteId, request.uid, request.name).catch(showError)} disabled={!services || !remoteId}><Check size={13} /> Allow</button><button className="decline-request" onClick={() => rejectJoinRequest(services.database, remoteId, request.uid).catch(showError)} disabled={!services || !remoteId}>Decline</button></div></div>)}
                    {!Object.values(session.joinRequests || {}).some((request) => request.status === 'pending') && <p className="no-join-requests">No pending requests. New requests will appear here.</p>}</div>}
                </section>
                <footer className="studio-footer"><span>SLIDEO STUDIO <span className="footer-dot">·</span> LIVE INTERACTION, WITHOUT THE FRICTION</span></footer>
            </main>
            {allResponsesOpen && <div className="responses-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAllResponsesOpen(false) }}>
                <section className="responses-dialog" role="dialog" aria-modal="true" aria-labelledby="responses-title">
                    <header className="responses-dialog-header"><div><span className="eyebrow"><span className="eyebrow-line" />SESSION SUMMARY</span><h2 id="responses-title">All responses</h2><p>{voteCount} responses across {polls.length} questions</p></div><button className="icon-button" aria-label="Close all responses" onClick={() => setAllResponsesOpen(false)}><X size={19} /></button></header>
                    <div className="responses-dialog-body">{polls.length ? polls.map((poll, questionIndex) => {
                        const answerEntries = Object.entries(poll.responses || {})
                        const answers = answerEntries.map(([, answer]) => answer)
                        const isOptionQuestion = optionQuestionTypes.has(pollType(poll))
                        const correctIndices = pollType(poll) === 'msq' ? asArray(poll.correctIndices).map(Number) : [Number(poll.correctIndex)]
                        const expectedAnswer = pollType(poll) === 'msq'
                            ? correctIndices.map((index) => asArray(poll.options)[index]).filter(Boolean).join(', ')
                            : isOptionQuestion ? asArray(poll.options)[poll.correctIndex] : poll.correctAnswer
                        return <article className="responses-question-card" key={poll.id || questionIndex}>
                            <div className="responses-question-heading"><span>Q{String(questionIndex + 1).padStart(2, '0')} · SLIDE {poll.slideStart}{poll.slideEnd !== poll.slideStart ? `–${poll.slideEnd}` : ''}</span><strong>{answers.length} {answers.length === 1 ? 'response' : 'responses'}</strong></div>
                            <h3>{poll.question || 'Untitled question'}</h3><span className="responses-question-type">{questionTypes.find(([type]) => type === pollType(poll))?.[1] || 'Question'}</span>
                            {isOptionQuestion ? <div className="responses-breakdown">{asArray(poll.options).map((option, index) => {
                                const count = answers.filter((answer) => Array.isArray(answer) ? answer.map(Number).includes(index) : Number(answer) === index).length
                                const percent = answers.length ? Math.round(count / answers.length * 100) : 0
                                return <div className={`responses-option ${correctIndices.includes(index) && hasCorrectAnswer(poll) ? 'is-correct' : ''}`} key={index}><div><span>{option || `Option ${index + 1}`}</span><strong>{count} · {percent}%</strong></div><i><span style={{ width: `${percent}%` }} /></i></div>
                            })}<div className="responses-text-list">{answers.map((answer, index) => <p key={index}><strong>{session.participants?.[answerEntries[index][0]]?.name || 'Participant'}:</strong> {Array.isArray(answer) ? answer.map((item) => asArray(poll.options)[Number(item)]).join(', ') : asArray(poll.options)[Number(answer)] || String(answer)}</p>)}</div></div> : <div className="responses-text-list">{answers.length ? answers.map((answer, index) => <p key={index}><strong>{session.participants?.[answerEntries[index][0]]?.name || 'Participant'}:</strong> {String(answer)}</p>) : <span>No responses yet.</span>}</div>}
                            {hasCorrectAnswer(poll) && <div className="responses-correct-answer"><CheckCircle2 size={14} /><span>Correct answer</span><strong>{expectedAnswer}</strong></div>}
                        </article>
                    }) : <div className="responses-empty"><BarChart3 size={22} /><h3>No questions yet</h3><p>Add a poll to start collecting responses.</p></div>}</div>
                </section>
            </div>}
            {notice && <div className="toast" role="status">{notice}</div>}
        </div>
    )
}

function WorkspaceHome({ workspaces, user, demoMode, onOpen, onCreate, onRename, onDelete, onSignOut }) {
    const responseCount = (workspace) => asArray(workspace.session?.polls).reduce((total, poll) => total + Object.keys(poll.responses || {}).length, 0)
    return <div className="workspace-home-shell">
        <header className="topbar workspace-home-topbar">
            <a className="brand" href="/" aria-label="Slideo home"><span className="brand-mark"><span /></span><span>slideo</span></a>
            <span className="workspace-home-label">YOUR WORKSPACES</span>
            <div className="profile-menu-wrap"><span className="workspace-user-label">{demoMode ? 'Local demo' : user?.displayName || user?.email || 'Presenter'}</span><button className="workspace-signout" onClick={onSignOut}><LogOut size={14} />{demoMode ? 'Exit demo' : 'Sign out'}</button></div>
        </header>
        <main className="workspace-home-main">
            <div className="workspace-home-intro"><div><span className="eyebrow"><span className="eyebrow-line" />PRESENTER HOME</span><h1>Your workspaces</h1><p>Keep each presentation and its questions in a separate workspace.</p></div><button className="workspace-create-button" onClick={onCreate}><Plus size={16} /> New workspace</button></div>
            {workspaces.length ? <div className="workspace-card-grid">{workspaces.map((workspace) => {
                const polls = asArray(workspace.session?.polls)
                const responses = responseCount(workspace)
                const live = workspace.session?.status === 'live'
                return <article className="workspace-card" key={workspace.id}>
                    <button className="workspace-card-open" onClick={() => onOpen(workspace)} aria-label={`Open ${workspace.name || 'Untitled'} workspace`}>
                        <div className="workspace-card-top"><span className="workspace-card-mark"><Presentation size={19} /></span><span className={`workspace-state ${live ? 'is-live' : ''}`}><i />{live ? 'LIVE NOW' : workspace.session?.status === 'ended' ? 'PREVIOUS' : 'READY'}</span></div>
                        <h2>{workspace.name || 'Untitled'}</h2><p>{workspace.session?.deck?.name || 'No presentation added yet'}</p>
                        <div className="workspace-card-stats"><span><strong>{polls.length}</strong> questions</span><span><strong>{responses}</strong> responses</span></div>
                        <span className="workspace-card-open-label">Open presenter studio <ArrowRight size={14} /></span>
                    </button>
                    <div className="workspace-card-actions"><button className="workspace-rename-button" title="Rename workspace" aria-label={`Rename ${workspace.name || 'Untitled'} workspace`} onClick={() => onRename(workspace)}><span>{workspace.name === 'Untitled' ? 'Rename untitled workspace' : 'Rename'}</span><Pencil size={13} /></button><button className="workspace-delete-button" title="Delete workspace and related data" aria-label={`Delete ${workspace.name || 'Untitled'} workspace`} onClick={() => onDelete(workspace)}><span>Delete</span><Trash2 size={13} /></button></div>
                </article>
            })}</div> : <div className="workspace-home-empty"><div className="empty-icon"><Presentation size={22} /></div><h2>Create your first workspace</h2><p>Name a workspace to start preparing slides and questions.</p><button className="workspace-create-button" onClick={onCreate}><Plus size={16} /> New workspace</button></div>}
            <footer className="workspace-home-footer"><span className="workspace-home-count">{workspaces.length} {workspaces.length === 1 ? 'workspace' : 'workspaces'} · PRIVATE TO YOUR ACCOUNT</span><span className="workspace-home-credit">Developed by <a href="https://divyanshugupta.pages.dev" target="_blank" rel="noreferrer">Divyanshu Gupta</a></span></footer>
        </main>
    </div>
}

function PresentationView({ session, shareUrl, slideNumber, slideCount, deckFile, deckPreview, database, isFullscreen, onSlideChange, onSlideCount, onSelectPoll, onAddQuestion, onToggleResults, onToggleFullscreen, onStop, editingPoll, onEditingPollChange, onSavePoll, onDeletePoll, onApproveJoinRequest, onRejectJoinRequest }) {
    const polls = orderedPolls(session.polls)
    const [questionEditorOpen, setQuestionEditorOpen] = useState(false)
    const slideQuestions = polls.filter((poll) => slideNumber >= poll.slideStart && slideNumber <= poll.slideEnd)
    const activePoll = polls.find((poll) => poll.id === session.activePollId) || polls.find((poll) => slideNumber >= poll.slideStart && slideNumber <= poll.slideEnd)
    const responses = Object.values(activePoll?.responses || {})
    const questionTypeLabel = questionTypes.find(([type]) => type === pollType(activePoll))?.[1] || 'No active question'
    const correctAnswer = activePoll && (pollType(activePoll) === 'msq'
        ? asArray(activePoll.correctIndices).map((index) => activePoll.options?.[index]).filter(Boolean).join(', ')
        : optionQuestionTypes.has(pollType(activePoll))
            ? activePoll.options?.[activePoll.correctIndex]
            : activePoll.correctAnswer)

    function optionCount(index) {
        return responses.filter((answer) => Array.isArray(answer)
            ? answer.map(Number).includes(index)
            : Number(answer) === index).length
    }

    const freeResponses = responses.filter((answer) => !Array.isArray(answer) && typeof answer !== 'number')
    const pendingJoinRequests = Object.values(session.joinRequests || {}).filter((request) => request.status === 'pending')

    function addQuestionOnCurrentSlide() {
        onAddQuestion()
        setQuestionEditorOpen(true)
    }

    function updateQuestionEditor(patch) {
        onEditingPollChange((current) => current ? { ...current, ...patch } : current)
    }

    function toggleEditorCorrect(index) {
        if (!editingPoll) return
        if (pollType(editingPoll) === 'msq') {
            const current = asArray(editingPoll.correctIndices).map(Number)
            updateQuestionEditor({ correctIndices: current.includes(index) ? current.filter((item) => item !== index) : [...current, index] })
        } else {
            updateQuestionEditor({ correctIndex: editingPoll.correctIndex === index ? null : index })
        }
    }

    return <div className="presentation-mode">
        <header className="presentation-toolbar">
            <div className="presentation-brand"><span className="brand-mark"><span /></span><strong>slideo</strong><span className="presentation-live"><span className="live-pulse" /> PRESENTING</span></div>
            <div className="presentation-position">SLIDE <strong>{slideNumber}</strong><span>/</span>{slideCount}</div>
            <div className="presentation-actions">
                <span className="presentation-room-code">ROOM <strong>{session.authCode}</strong></span>
                <button className={`reveal-results-button ${session.resultsVisible ? 'revealed' : ''}`} onClick={onToggleResults} disabled={!activePoll}><BarChart3 size={15} />{session.resultsVisible ? 'Hide results' : 'Show results to audience'}</button>
                <button className="presentation-icon-button" title={isFullscreen ? 'Exit full screen' : 'Enter full screen'} aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'} onClick={onToggleFullscreen}>{isFullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
                <button className="presentation-stop-button" onClick={onStop}><Square size={14} /> Stop</button>
            </div>
        </header>
        <main className="presentation-layout">
            <section className="presentation-stage">
                <div className="presentation-slide-frame">
                    {deckPreview ? <iframe title="Live HTML presentation" src={deckPreview} sandbox="allow-scripts allow-same-origin" />
                        : session.deck?.databasePath ? <PptxPreview database={database} deck={session.deck} slideNumber={slideNumber} onSlideCount={onSlideCount} />
                            : session.deck?.url ? <DeckFrame deck={session.deck} title={session.title} />
                                : deckFile && /\.(ppt|pptx)$/i.test(deckFile.name) ? <PptxPreview file={deckFile} deck={session.deck} slideNumber={slideNumber} onSlideCount={onSlideCount} />
                                    : <SlideArtwork title={session.title} deck={session.deck} />}
                </div>
                <div className="presentation-slide-controls"><button aria-label="Previous slide" title="Previous slide" disabled={slideNumber <= 1} onClick={() => onSlideChange(slideNumber - 1)}><ArrowLeft size={17} /></button><span>{slideNumber} <i>/</i> {slideCount}</span><button aria-label="Next slide" title="Next slide" disabled={slideNumber >= slideCount} onClick={() => onSlideChange(slideNumber + 1)}><ArrowRight size={17} /></button></div>
            </section>
            <aside className="presentation-sidebar">
                <div className="sidebar-section-heading"><span>LIVE QUESTION</span><span>{activePoll ? `SLIDE ${activePoll.slideStart}${activePoll.slideEnd !== activePoll.slideStart ? `–${activePoll.slideEnd}` : ''}` : 'NO QUESTION'}</span></div>
                {activePoll ? <>
                    {slideQuestions.length > 1 && <div className="presentation-question-tabs" aria-label="Questions on this slide">{slideQuestions.map((poll, index) => <button key={poll.id} className={poll.id === activePoll.id ? 'active' : ''} aria-label={`Show question ${index + 1}`} onClick={() => onSelectPoll(poll)}>Q{index + 1}</button>)}</div>}
                    <h1 className="presentation-question">{activePoll.question || 'Untitled question'}</h1>
                    <span className="presentation-question-type">{questionTypeLabel}</span>
                    <div className="presentation-response-total"><Users size={15} /><strong>{responses.length}</strong><span>responses</span></div>
                    {optionQuestionTypes.has(pollType(activePoll)) ? <div className="presentation-result-list">{asArray(activePoll.options).map((option, index) => {
                        const count = optionCount(index)
                        const percent = responses.length ? Math.round(count / responses.length * 100) : 0
                        const isCorrect = pollType(activePoll) === 'msq'
                            ? asArray(activePoll.correctIndices).includes(index)
                            : activePoll.correctIndex === index
                        return <div className={`presentation-result-row ${isCorrect ? 'correct' : ''}`} key={index}><div className="presentation-result-label"><span>{option || `Option ${index + 1}`}</span>{isCorrect && <CheckCircle2 size={14} />}</div><div className="presentation-result-bar"><span style={{ width: `${percent}%` }} /></div><small>{count} <i>·</i> {percent}%</small></div>
                    })}</div> : <div className="presentation-free-responses">{freeResponses.length ? freeResponses.map((answer, index) => <div className="presentation-free-response" key={index}>{String(answer)}</div>) : <span>Responses will appear here.</span>}</div>}
                    {hasCorrectAnswer(activePoll) && <div className="presentation-correct-answer"><span><CheckCircle2 size={14} /> CORRECT ANSWER</span><strong>{correctAnswer}</strong></div>}
                    <button className="presentation-add-question" onClick={addQuestionOnCurrentSlide}><Plus size={14} /> Add another question to this slide</button>
                </> : <div className="presentation-no-question"><Eye size={19} /><p>There is no question on slide {slideNumber}.</p><button onClick={addQuestionOnCurrentSlide}><Plus size={14} /> Add a question</button></div>}
                {session.accessMode === 'request' && <div className="presentation-join-requests"><div className="presentation-requests-heading"><strong>Join requests</strong><span>{pendingJoinRequests.length}</span></div>{pendingJoinRequests.length ? pendingJoinRequests.map((request) => <div className="presentation-request" key={request.uid}><span className="presentation-request-avatar">{String(request.name || 'P').trim().charAt(0).toUpperCase()}</span><span className="presentation-request-person"><strong>{request.name}</strong><small>{request.email || 'Signed-in participant'}</small></span><button aria-label={`Approve ${request.name}`} title="Approve join request" onClick={() => onApproveJoinRequest(request)}><Check size={13} /></button><button className="presentation-request-decline" aria-label={`Decline ${request.name}`} title="Decline join request" onClick={() => onRejectJoinRequest(request)}><X size={13} /></button></div>) : <p>No pending requests.</p>}</div>}
                <div className="presentation-public-status"><span className={`public-status-dot ${session.resultsVisible ? 'visible' : ''}`} />{session.resultsVisible ? 'Results visible to audience' : 'Results hidden from audience'}</div>
                <div className="presentation-share-link"><span>ROOM CODE</span><strong>{session.authCode}</strong><small>{shareUrl?.replace(/^https?:\/\//, '')}</small></div>
            </aside>
        </main>
        {questionEditorOpen && editingPoll && <div className="live-question-overlay"><section className="live-question-editor" role="dialog" aria-modal="true" aria-labelledby="live-question-title">
            <header className="live-question-header"><div><span className="eyebrow"><span className="eyebrow-line" />QUESTION FOR SLIDE {editingPoll.slideStart}</span><h2 id="live-question-title">Add a question</h2></div><button className="presentation-icon-button" aria-label="Close question editor" onClick={() => setQuestionEditorOpen(false)}><X size={17} /></button></header>
            <div className="live-question-fields">
                <label className="field-label" htmlFor="live-question-type">QUESTION TYPE</label>
                <select id="live-question-type" className="question-type-select" value={pollType(editingPoll)} onChange={(event) => updateQuestionEditor({ type: event.target.value })}>{questionTypes.map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select>
                <label className="field-label" htmlFor="live-question-text">YOUR QUESTION</label>
                <textarea autoFocus id="live-question-text" className="question-input" rows="3" placeholder="What do you want to ask?" value={editingPoll.question} onChange={(event) => updateQuestionEditor({ question: event.target.value })} />
                {optionQuestionTypes.has(pollType(editingPoll)) ? <>
                    <div className="live-options-heading"><span className="field-label">ANSWER OPTIONS</span><span>Click the check to mark correct</span></div>
                    <div className="option-list">{asArray(editingPoll.options).map((option, index) => {
                        const correct = pollType(editingPoll) === 'msq' ? asArray(editingPoll.correctIndices).map(Number).includes(index) : Number(editingPoll.correctIndex) === index
                        return <div className={`option-row ${correct ? 'is-correct' : ''}`} key={index}><span className="option-marker" style={{ '--option-color': choices[index % choices.length] }}>{String.fromCharCode(65 + index)}</span><input aria-label={`Answer option ${index + 1}`} value={option} placeholder={`Option ${String.fromCharCode(65 + index)}`} onChange={(event) => updateQuestionEditor({ options: asArray(editingPoll.options).map((item, optionIndex) => optionIndex === index ? event.target.value : item) })} /><button className="correct-toggle" aria-label={`Mark option ${index + 1} correct`} onClick={() => toggleEditorCorrect(index)}>{correct ? <Check size={14} /> : <span />}</button></div>
                    })}</div>
                    <button className="add-option" onClick={() => updateQuestionEditor({ options: [...asArray(editingPoll.options), ''] })}><Plus size={14} /> Add another option</button>
                </> : <label className="live-correct-answer"><span className="field-label">EXPECTED ANSWER (OPTIONAL)</span><input className="correct-answer-input" type={pollType(editingPoll) === 'number' ? 'number' : 'text'} step={pollType(editingPoll) === 'number' ? 'any' : undefined} value={editingPoll.correctAnswer || ''} onChange={(event) => updateQuestionEditor({ correctAnswer: event.target.value })} placeholder={pollType(editingPoll) === 'number' ? 'Enter the correct number' : 'Enter an accepted answer'} /></label>}
                <label className="live-reveal-toggle"><input type="checkbox" checked={Boolean(editingPoll.revealCorrect)} onChange={(event) => updateQuestionEditor({ revealCorrect: event.target.checked })} /><span><strong>Reveal correct answer</strong><small>Mark correct responses when results are shared.</small></span></label>
                <label className="live-reveal-toggle"><input type="checkbox" checked={Boolean(editingPoll.revealAfterAll)} onChange={(event) => updateQuestionEditor({ revealAfterAll: event.target.checked })} /><span><strong>Wait for everyone</strong><small>Hold public results until joined viewers respond.</small></span></label>
            </div>
            <footer className="live-question-footer"><button className="live-delete-question" onClick={() => { if (onDeletePoll(editingPoll.id, { confirmDelete: false })) setQuestionEditorOpen(false) }}><Trash2 size={14} /> Delete question</button><button className="presentation-cancel-question" onClick={() => setQuestionEditorOpen(false)}>Close</button><button className="save-poll" onClick={() => { if (onSavePoll()) setQuestionEditorOpen(false) }}><Check size={15} /> Save question</button></footer>
        </section></div>}
    </div>
}

function SlideArtwork({ title, deck }) {
    return <div className="sample-slide"><div className="slide-decoration deco-one" /><div className="slide-decoration deco-two" /><div className="slide-topline"><span>FIELD NOTES / 04</span><span>SLIDEO STUDIO</span></div><div className="slide-content"><span className="slide-eyebrow">A BETTER WAY TO GATHER</span><h3>{title || 'Your presentation'}</h3><p>Good ideas happen when<br />everyone gets in the room.</p><div className="slide-bottom"><span>IDEAS INTO ACTION</span><span>{deck?.type === 'sample' ? '2025 / 26' : 'PRESENTATION'}</span></div></div><div className="slide-orbit"><span /><i /><b /></div></div>
}

function DeckFrame({ deck, title }) {
    const src = deck.type === 'pptx'
        ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(deck.url)}`
        : deck.url
    return <iframe title={`${title} presentation`} src={src} allow="fullscreen" />
}

function PptxPreview({ database, deck, file, slideNumber = 1, onSlideCount }) {
    const containerRef = useRef(null)
    const previewerRef = useRef(null)
    const [downloadUrl, setDownloadUrl] = useState('')
    const [previewStatus, setPreviewStatus] = useState('loading')

    useEffect(() => {
        if (!file && (!database || !deck.databasePath)) return undefined
        let active = true
        let objectUrl = ''
        setPreviewStatus('loading')
        setDownloadUrl('')
        async function loadAndRender() {
            let previewer
            try {
                let bytes
                let contentType
                if (file) {
                    bytes = new Uint8Array(await file.arrayBuffer())
                    contentType = file.type || 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                } else {
                    const record = await loadPresenterDeck(database, deck.databasePath)
                    if (!record?.base64) throw new Error('The PowerPoint data is missing.')
                    const binary = atob(record.base64)
                    bytes = new Uint8Array(binary.length)
                    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
                    contentType = record.contentType
                }
                objectUrl = URL.createObjectURL(new Blob([bytes], { type: contentType || 'application/octet-stream' }))
                if (!active) return
                setDownloadUrl(objectUrl)
                const { init } = await import('pptx-preview')
                if (!active || !containerRef.current) return
                containerRef.current.replaceChildren()
                const width = containerRef.current.clientWidth || 960
                previewer = init(containerRef.current, { width, height: Math.round(width * 9 / 16), mode: 'slide' })
                await previewer.preview(bytes.buffer)
                previewerRef.current = previewer
                const slideCount = previewer.slideCount || 1
                onSlideCount?.(slideCount)
                previewer.renderSingleSlide(Math.max(0, Math.min(slideCount - 1, slideNumber - 1)))
                if (active) setPreviewStatus('ready')
            } catch (error) {
                if (active) setPreviewStatus('error')
            }
        }
        loadAndRender()
        return () => {
            active = false
            previewerRef.current?.destroy()
            previewerRef.current = null
            if (objectUrl) URL.revokeObjectURL(objectUrl)
            containerRef.current?.replaceChildren()
        }
    }, [database, deck.databasePath, file, onSlideCount])

    useEffect(() => {
        const previewer = previewerRef.current
        if (!previewer || !previewer.slideCount) return
        previewer.renderSingleSlide(Math.max(0, Math.min(previewer.slideCount - 1, slideNumber - 1)))
    }, [slideNumber])

    return <div className="pptx-preview">
        <div className="pptx-preview-canvas" ref={containerRef} />
        {previewStatus === 'loading' && <div className="pptx-preview-message">Loading PowerPoint preview…</div>}
        {previewStatus === 'error' && <div className="pptx-preview-message">Preview unavailable. Download the presentation instead.</div>}
        {downloadUrl && <a className="pptx-download-link" href={downloadUrl} download={deck.name || 'presentation.pptx'} title="Download presentation"><ArrowDownToLine size={14} /><span>Download</span></a>}
    </div>
}

function AudienceView({ authCode }) {
    const [session, setSession] = useState(null)
    const [error, setError] = useState('')
    const [databaseSessionId, setDatabaseSessionId] = useState(null)
    const [isLocalRoom, setIsLocalRoom] = useState(false)
    const [audienceUser, setAudienceUser] = useState(null)
    const [audienceEmail, setAudienceEmail] = useState('')
    const [audiencePassword, setAudiencePassword] = useState('')
    const [audienceName, setAudienceName] = useState('')
    const [audienceAuthMode, setAudienceAuthMode] = useState('login')
    const [authBusy, setAuthBusy] = useState(false)
    const [joinRequestSent, setJoinRequestSent] = useState(false)
    const registeredRef = useRef(false)
    const normalizedCode = authCode.trim().toUpperCase()
    const [attendeeId] = useState(() => {
        const key = 'slideo-attendee-id'
        let id = localStorage.getItem(key)
        if (!id) { id = makeId(); localStorage.setItem(key, id) }
        return id
    })
    const config = useMemo(() => readFirebaseConfig(), [])
    const services = useMemo(() => {
        if (!config?.apiKey || !config?.databaseURL) return null
        try { return connectFirebase(config) } catch { return null }
    }, [config])

    useEffect(() => services ? onAuthStateChanged(services.auth, setAudienceUser) : undefined, [services])

    useEffect(() => {
        let active = true
        let unsubscribe = () => {}
        registeredRef.current = false
        setSession(null)
        setError('')
        setDatabaseSessionId(null)
        setIsLocalRoom(false)

        try {
            const localSession = JSON.parse(localStorage.getItem(localKey))
                if (localSession?.authCode === normalizedCode) {
                    setSession(normalizeSession(localSession))
                setIsLocalRoom(true)
                return () => { active = false }
            }
        } catch { }

        if (!services) {
            setError('That room code is invalid or Firebase is not configured for this app.')
            return () => { active = false }
        }

        resolveRoomCode(services.database, normalizedCode).then((resolvedId) => {
            if (!active) return
            if (!resolvedId) {
                setError('That room code is invalid or has expired.')
                return
            }
            setDatabaseSessionId(resolvedId)
            unsubscribe = subscribeSession(services.database, resolvedId, (data) => {
                const normalizedSession = normalizeSession(data)
                setSession(normalizedSession)
                const accessAllowed = data?.accessMode !== 'request' || Boolean(data?.joinRequests?.[audienceUser?.uid]?.status === 'approved')
                if (data && accessAllowed && !registeredRef.current) {
                    registeredRef.current = true
                    registerAttendee(services.database, resolvedId, audienceUser?.uid || attendeeId, audienceUser?.displayName || audienceUser?.email || 'Guest').catch(() => { })
                }
            })
        }).catch(() => {
            if (active) setError('Could not verify this room code. Check Firebase Realtime Database access.')
        })
        return () => { active = false; unsubscribe() }
    }, [normalizedCode, services, attendeeId, audienceUser])

    const polls = asArray(session?.polls)
    const activePoll = polls.find((poll) => poll.id === session?.activePollId) || polls.find((poll) => Number(poll.slideStart) <= Number(session?.activeSlide) && Number(poll.slideEnd) >= Number(session?.activeSlide))
    const activeType = pollType(activePoll)
    const [pendingAnswer, setPendingAnswer] = useState('')
    const responses = activePoll?.responses || {}
    const responseAttendeeId = session?.accessMode === 'request' ? audienceUser?.uid : attendeeId
    const myAnswer = responses[responseAttendeeId]
    const responseCount = Object.keys(responses).length
    const participantCount = Object.keys(session?.participants || {}).length
    const resultsReady = !activePoll?.revealAfterAll || (participantCount > 0 && responseCount >= participantCount)
    const showResults = Boolean(session?.resultsVisible) && resultsReady

    useEffect(() => {
        setPendingAnswer(activeType === 'msq' ? [] : '')
    }, [activePoll?.id, activeType])

    function renderOptionList() {
        const selected = myAnswer !== undefined ? myAnswer : pendingAnswer
        return <div className="audience-options">{asArray(activePoll.options).map((option, index) => {
            const selectedOption = activeType === 'msq'
                ? asArray(selected).map(Number).includes(index)
                : selected !== '' && selected !== undefined && Number(selected) === index
            const correctOption = activeType === 'msq'
                ? asArray(activePoll.correctIndices).map(Number).includes(index)
                : Number(activePoll.correctIndex) === index
            const count = Object.values(responses).filter((answer) => Array.isArray(answer) ? answer.map(Number).includes(index) : Number(answer) === index).length
            const percent = responseCount ? Math.round((count / responseCount) * 100) : 0
            const isCorrect = showResults && activePoll.revealCorrect && correctOption
            return <button key={index} disabled={myAnswer !== undefined || showResults} onClick={() => activeType === 'msq' ? togglePendingOption(index) : submitAnswer(index)} className={`audience-option ${selectedOption ? 'chosen' : ''} ${showResults ? 'result' : ''} ${isCorrect ? 'answer-correct' : ''}`}><span className="audience-option-letter">{String.fromCharCode(65 + index)}</span><span className="audience-option-text">{option || `Option ${String.fromCharCode(65 + index)}`}</span>{showResults && <span className="result-percent">{percent}%</span>}{isCorrect && <CheckCircle2 size={17} />}{showResults && <span className="result-fill" style={{ width: `${percent}%` }} />}</button>
        })}</div>
    }

    function togglePendingOption(index) {
        setPendingAnswer((current) => {
            const selected = asArray(current).map(Number)
            return selected.includes(index) ? selected.filter((item) => item !== index) : [...selected, index]
        })
    }

    async function submitAnswer(answer) {
        if (session.status === 'ended' || !activePoll || myAnswer !== undefined) return
        let response = answer
        if (activeType === 'msq') {
            response = [...new Set(asArray(answer).map(Number))].sort((a, b) => a - b)
            if (!response.length) return
        } else if (activeType === 'number') {
            response = Number(String(answer).trim())
            if (!Number.isFinite(response)) return
        } else if (activeType === 'fill' || activeType === 'text') {
            response = String(answer).trim()
            if (!response) return
        } else {
            response = Number(answer)
        }
        if (services && databaseSessionId) {
            try { await writeVote(services.database, databaseSessionId, activePoll.id, responseAttendeeId, response) }
            catch { setError('Your answer could not be sent. Check the Firebase Realtime Database rules.') }
        } else if (isLocalRoom) {
            const next = { ...session, polls: polls.map((poll) => poll.id === activePoll.id ? { ...poll, responses: { ...(poll.responses || {}), [responseAttendeeId]: response } } : poll) }
            setSession(next)
            localStorage.setItem(localKey, JSON.stringify(next))
        }
    }

    if (error) return <AudienceMessage title="Room unavailable" message={error} />
    if (session?.accessMode === 'request' && !session?.joinRequests?.[audienceUser?.uid]?.status?.match(/^approved$/)) {
        const status = audienceUser ? session.joinRequests?.[audienceUser.uid]?.status : null
        if (!audienceUser) return <div className="auth-shell audience-auth-shell">
            <header className="auth-topbar"><a className="brand" href="/"><span className="brand-mark"><span /></span><span>slideo</span></a><span className="join-header-label">ROOM ACCESS</span></header>
            <main className="auth-main">
                <div className="auth-intro"><span className="eyebrow"><span className="eyebrow-line" />PRESENTER APPROVAL</span><h1>Good ideas<br /><span>need a room.</span></h1><p>Sign in to request access to <strong>{session.title}</strong>. The presenter will approve your request before you join.</p><div className="auth-art" aria-hidden="true"><span className="auth-art-counter">ROOM ACCESS / PRIVATE</span><span className="auth-art-rule" /><span className="auth-art-swatch" /><span className="auth-art-caption">SIGN IN / REQUEST / JOIN</span></div></div>
                <section className="auth-panel" aria-labelledby="audience-auth-title">
                    <div className="room-signin-notice"><LockKeyhole size={15} /><span>To join this room, sign in first.</span></div>
                    <div className="auth-panel-heading"><span className="auth-lock"><LockKeyhole size={16} /></span><div><h2 id="audience-auth-title">{audienceAuthMode === 'login' ? 'Welcome back' : 'Create your account'}</h2><p>{audienceAuthMode === 'login' ? 'Sign in to request room access.' : 'Create an account to request access.'}</p></div></div>
                    <div className="auth-tabs" role="tablist" aria-label="Account access"><button role="tab" aria-selected={audienceAuthMode === 'login'} className={audienceAuthMode === 'login' ? 'active' : ''} onClick={() => { setAudienceAuthMode('login'); setError('') }}>Log in</button><button role="tab" aria-selected={audienceAuthMode === 'signup'} className={audienceAuthMode === 'signup' ? 'active' : ''} onClick={() => { setAudienceAuthMode('signup'); setError('') }}>Sign up</button></div>
                    <button className="google-button" type="button" disabled={authBusy || !services} onClick={async () => { setError(''); setAuthBusy(true); try { await signInWithPopup(services.auth, new GoogleAuthProvider()) } catch (authError) { setError(authError.message || 'Google sign-in failed.') } finally { setAuthBusy(false) } }}><span className="google-g">G</span>Continue with Google</button>
                    <div className="auth-separator"><span>or continue with email</span></div>
                    <form className="auth-form" onSubmit={async (event) => { event.preventDefault(); setError(''); setAuthBusy(true); try { if (audienceAuthMode === 'signup') { if (!audienceName.trim()) throw new Error('Enter your name to create an account.'); const credential = await createUserWithEmailAndPassword(services.auth, audienceEmail, audiencePassword); await updateProfile(credential.user, { displayName: audienceName.trim() }) } else { await signInWithEmailAndPassword(services.auth, audienceEmail, audiencePassword) } } catch (authError) { setError(authError.message || 'Sign-in failed.') } finally { setAuthBusy(false) } }}>
                        {audienceAuthMode === 'signup' && <><label htmlFor="audience-auth-name">Your name</label><input id="audience-auth-name" type="text" autoComplete="name" maxLength={80} required value={audienceName} onChange={(event) => setAudienceName(event.target.value)} placeholder="Name shown to your presenter" /></>}
                        <label htmlFor="audience-auth-email">Email address</label><input id="audience-auth-email" type="email" autoComplete="email" required value={audienceEmail} onChange={(event) => setAudienceEmail(event.target.value)} placeholder="you@example.com" />
                        <label htmlFor="audience-auth-password">Password</label><input id="audience-auth-password" type="password" autoComplete={audienceAuthMode === 'login' ? 'current-password' : 'new-password'} minLength={6} required value={audiencePassword} onChange={(event) => setAudiencePassword(event.target.value)} placeholder="At least 6 characters" />
                        {error && <div className="auth-error" role="alert">{error}</div>}
                        <button className="auth-submit" type="submit" disabled={authBusy || !services}>{authBusy ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}{audienceAuthMode === 'login' ? 'Log in' : 'Create account'}<ArrowRight size={15} /></button>
                    </form>
                    <p className="auth-footnote">Joining a public room? <a href="/?join=1">Enter its room code</a></p>
                </section>
            </main>
        </div>
        return <div className="audience-shell"><header className="audience-topbar"><a className="brand" href="/"><span className="brand-mark"><span /></span><span>slideo</span></a></header><main className="audience-message"><LockKeyhole size={25} /><h1>{status === 'pending' ? 'Request sent' : status === 'rejected' ? 'Request declined' : 'Request to join'}</h1><p>{status === 'pending' ? 'The presenter will review your request.' : status === 'rejected' ? 'The presenter did not approve your request.' : 'Your name will be shared with the presenter.'}</p>{!status && <button className="launch-button" onClick={() => sendJoinRequest(services.database, databaseSessionId, audienceUser).catch((authError) => setError(authError.message))}>Send join request <ArrowRight size={15} /></button>}{error && <p>{error}</p>}</main></div>
    }
    if (!session) return <AudienceMessage title="Finding your room…" message="Hang tight while we connect to the presentation." loading />
    if (session.status === 'ended') return <AudienceMessage title="Presentation ended" message="The presenter has stopped this room." />

    return (
        <div className="audience-shell">
            <header className="audience-topbar">
                <a className="brand" href="/"><span className="brand-mark"><span /></span><span>slideo</span></a>
                <div className="audience-room"><span className="live-pulse" />LIVE ROOM</div>
                <span className="audience-count"><Users size={15} />{participantCount || responseCount} here</span>
                <a className="room-exit-link" href="/?join=1"><ArrowLeft size={14} /><span>Exit room</span></a>
            </header>
            <main className="audience-main">
                <div className="audience-title">
                    <span className="eyebrow"><span className="eyebrow-line" />YOU'RE IN THE ROOM</span>
                    <h1>{session.title}</h1>
                    <p>Slide {session.activeSlide || activePoll?.slideStart || 1} of {session.deck?.slides || '—'} <span>·</span> Your answer is anonymous</p>
                </div>
                {session.deck?.url && <div className="audience-deck"><DeckFrame deck={session.deck} title={session.title} /></div>}
                {session.deck?.databasePath && <div className="audience-deck"><PptxPreview database={services?.database} deck={session.deck} slideNumber={session.activeSlide || 1} /></div>}
                {activePoll ? <section className="audience-poll">
                    <div className="poll-meta"><span>QUICK POLL</span><span>SLIDE {activePoll.slideStart}{activePoll.slideEnd !== activePoll.slideStart ? `–${activePoll.slideEnd}` : ''}</span></div>
                    <h2>{activePoll.question || 'The presenter is preparing a question…'}</h2>
                    {myAnswer !== undefined && !showResults ? <div className="waiting-state">
                        <div className="waiting-check"><Check size={23} /></div>
                        <h3>Answer received.</h3>
                        <p>{session.resultsVisible ? 'Results will appear as soon as everyone has voted.' : 'The presenter has not shared the results yet.'}</p>
                        <div className="waiting-progress"><span style={{ width: `${participantCount ? Math.min(100, responseCount / participantCount * 100) : 100}%` }} /></div>
                        <small>{responseCount} of {participantCount || 'all'} responses</small>
                    </div> : activeType === 'mcq' || activeType === 'msq' ? <>
                        {renderOptionList()}
                        {activeType === 'msq' && myAnswer === undefined && <button className="submit-answer" disabled={!asArray(pendingAnswer).length} onClick={() => submitAnswer(pendingAnswer)}>Submit answers</button>}
                    </> : activeType === 'dropdown' ? showResults ? renderOptionList() : <div className="answer-form">
                        <label className="field-label" htmlFor="audience-dropdown">CHOOSE AN ANSWER</label>
                        <select id="audience-dropdown" className="audience-answer-select" value={pendingAnswer} onChange={(event) => setPendingAnswer(event.target.value)}><option value="">Select an option</option>{asArray(activePoll.options).map((option, index) => <option key={index} value={index}>{option}</option>)}</select>
                        <button className="submit-answer" disabled={pendingAnswer === ''} onClick={() => submitAnswer(pendingAnswer)}>Submit answer</button>
                    </div> : showResults ? <div className="free-response-result"><span>{responseCount} responses</span>{responses.map((answer, index) => <strong className="free-response-item" key={index}>{String(answer)}{activePoll.revealCorrect && hasCorrectAnswer(activePoll) && answerIsCorrect(activePoll, answer) ? <CheckCircle2 size={14} /> : null}</strong>)}</div> : <div className="answer-form">
                        <label className="field-label" htmlFor="audience-free-answer">{activeType === 'number' ? 'ENTER A NUMBER' : activeType === 'fill' ? 'FILL IN THE BLANK' : 'YOUR ANSWER'}</label>
                        {activeType === 'text' ? <textarea id="audience-free-answer" className="audience-text-answer" rows="3" value={pendingAnswer} onChange={(event) => setPendingAnswer(event.target.value)} placeholder="Type your response" /> : <input id="audience-free-answer" className="audience-text-answer" type={activeType === 'number' ? 'number' : 'text'} step={activeType === 'number' ? 'any' : undefined} value={pendingAnswer} onChange={(event) => setPendingAnswer(event.target.value)} placeholder={activeType === 'number' ? 'Enter a number' : 'Type your response'} />}
                        <button className="submit-answer" disabled={!String(pendingAnswer).trim()} onClick={() => submitAnswer(pendingAnswer)}>Submit answer</button>
                    </div>}
                    {showResults && <div className="results-caption"><CheckCircle2 size={15} />{myAnswer === undefined ? 'The presenter shared these results.' : activePoll.revealCorrect && hasCorrectAnswer(activePoll) ? answerIsCorrect(activePoll, myAnswer) ? 'You got it right.' : 'The correct answer is marked.' : 'Thanks for adding your voice.'}</div>}
                </section> : <section className="audience-waiting"><div className="waiting-check"><Eye size={22} /></div><h2>Keep this open.</h2><p>The presenter will share a question here when it’s time.</p></section>}
                <div className="audience-footer"><span><LockKeyhole size={12} /> Your response is only shared with the presenter</span><span>POWERED BY SLIDEO</span></div>
            </main>
        </div>
    )
}

function AudienceMessage({ title, message, loading }) {
    return <div className="audience-shell"><header className="audience-topbar"><a className="brand" href="/"><span className="brand-mark"><span /></span><span>slideo</span></a></header><main className="audience-message">{loading ? <LoaderCircle className="spin" size={22} /> : <CircleHelp size={25} />}<h1>{title}</h1><p>{message}</p><a href="/?join=1">Enter a room code <ArrowRight size={15} /></a></main></div>
}

export default App
