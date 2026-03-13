// ===== CONSTANTS =====
const ENERGY_COST           = 1
const ROUND_DURATION        = 120          // seconds
const RESTORE_THRESHOLD     = 15
const RESTORE_AMOUNT        = 15
const RESTORE_INTERVAL_MS   = 10 * 60 * 60 * 1000   // 10 hours
const REWARDED_ENERGY       = 5
const PURCHASE_ENERGY       = 100
const STREAK_CAP            = 9
const SAVE_VERSION          = 1

// ===== GLOBAL STATE =====
let ysdk       = null
let player     = null
let payments   = null
let promoFlags = {}

let booksData   = []
let authorsMap  = {}   // id → name

let playerStats = {
    scoreTotal:       0,
    journeysCount:    0,
    winStreakCurrent: 0,
    winStreakMax:     0,
    energy:           30,
}
let playerData = {
    saveVersion:              SAVE_VERSION,
    firstLaunchAt:            0,
    lastEnergyRestoreTimestamp: 0,
    playedBookIds:            [],
    currentRound:             null,
}

let currentRound      = null    // { bookId, startFraction, startedAt, isRetry }
let roundTimerHandle  = null
let roundTimeLeft     = ROUND_DURATION
let selectedBook      = null    // book chosen in search
let promoActive       = false
let energyProduct     = null    // { price, currencyCode }
let energyProductPromo = null
let energyModalCountdownHandle = null
let gameplayActive    = false
let adInProgress      = false

// ===== YANDEX SDK MOCK (for local dev) =====
function createMockSdk() {
    let _storage = {}
    try { _storage = JSON.parse(localStorage.getItem('bg2_mock_storage') || '{}') } catch {}
    const save = () => { try { localStorage.setItem('bg2_mock_storage', JSON.stringify(_storage)) } catch {} }

    return {
        serverTime:   () => Date.now(),
        getFlags:     async (opts) => opts?.defaultFlags || {},
        adv: {
            showFullscreenAdv: ({ callbacks } = {}) => {
                // Mock: skip ad instantly
                setTimeout(() => callbacks?.onClose?.(true), 300)
            },
            showRewardedVideo: ({ callbacks } = {}) => {
                const watched = confirm('Симуляция: посмотреть рекламу за награду?')
                setTimeout(() => {
                    if (watched) callbacks?.onRewarded?.()
                    callbacks?.onClose?.()
                }, 300)
            },
        },
        features: {
            LoadingAPI:  { ready: () => {} },
            GameplayAPI: { start: () => {}, stop: () => {} },
        },
    }
}

function createMockPlayer() {
    const KEY = 'bg2_player'
    let _stats = {}, _data = {}
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
        _stats = saved.stats || {}
        _data  = saved.data  || {}
    } catch {}
    const persist = () => {
        try { localStorage.setItem(KEY, JSON.stringify({ stats: _stats, data: _data })) } catch {}
    }
    return {
        getMode:       () => 'lite',
        getUniqueID:   () => 'local',
        getName:       () => 'Local',
        getStats:      async ()            => ({ ..._stats }),
        setStats:      async (s)           => { Object.assign(_stats, s); persist() },
        incrementStats: async (s)          => { for (const k in s) _stats[k] = (_stats[k] || 0) + s[k]; persist() },
        getData:       async ()            => ({ ..._data }),
        setData:       async (d, flush)    => { Object.assign(_data, d); persist() },
    }
}

function createMockPayments() {
    return {
        getCatalog:      async () => [
            { id: 'energy_100',       title: '100 энергии', price: '99 RUB',  priceCurrencyCode: 'RUB', getPriceCurrencyImage: () => null },
            { id: 'energy_100_promo', title: '100 энергии', price: '49 RUB',  priceCurrencyCode: 'RUB', getPriceCurrencyImage: () => null },
        ],
        purchase:        async ({ id }) => ({ productID: id }),
        consumePurchase: async (token)  => {},
        getPurchases:    async ()       => [],
    }
}

// ===== INITIALIZATION =====
async function init() {
    showScreen('screen-app-loading')

    // Load book data in parallel with SDK init
    await Promise.all([
        loadBooksData(),
        loadAuthorsData(),
        initSdk(),
    ])

    // Build search index once data is loaded
    buildSearchIndex()

    // Load player
    await loadPlayer()

    // Load payments (non-blocking)
    loadPaymentsModule().catch(e => console.warn('Payments unavailable:', e))

    // Check promo flags
    const serverTime = ysdk.serverTime()
    try {
        const flags = await ysdk.getFlags({ defaultFlags: { promostart: '', promostop: '' } })
        promoFlags = flags
        promoActive = checkPromoActive(flags, serverTime)
    } catch (e) {
        console.warn('getFlags failed:', e)
    }

    // Load progress
    await loadProgress()

    // Check energy restore
    await checkEnergyRestore()

    // Check unprocessed purchases
    checkUnprocessedPurchases().catch(() => {})

    // Subscribe to pause/resume events
    try {
        if (ysdk._events) {
            ysdk.on?.('game_api_pause',  onGamePause)
            ysdk.on?.('game_api_resume', onGameResume)
        }
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) onGamePause()
            else onGameResume()
        })
    } catch {}

    // Detect device type (mobile/desktop)
    detectDevice()

    // Setup all button handlers
    setupEventListeners()

    // Show main screen
    showMainScreen()

    // Signal Yandex that we're ready
    try { ysdk.features.LoadingAPI.ready() } catch {}
}

async function initSdk() {
    try {
        if (typeof YaGames !== 'undefined') {
            ysdk = await YaGames.init()
        } else {
            ysdk = createMockSdk()
        }
    } catch (e) {
        console.warn('SDK init failed, using mock:', e)
        ysdk = createMockSdk()
    }
}

async function loadPlayer() {
    try {
        if (typeof YaGames !== 'undefined' && ysdk) {
            player = await ysdk.getPlayer({ signed: false, scopes: false })
        } else {
            player = createMockPlayer()
        }
    } catch (e) {
        player = createMockPlayer()
    }
}

async function loadPaymentsModule() {
    try {
        if (typeof YaGames !== 'undefined' && ysdk) {
            payments = await ysdk.getPayments({ signed: false })
        } else {
            payments = createMockPayments()
        }
        await fetchProductPrices()
    } catch (e) {
        payments = createMockPayments()
        await fetchProductPrices()
    }
}

async function fetchProductPrices() {
    try {
        const catalog = await payments.getCatalog()
        for (const p of catalog) {
            if (p.id === 'energy_100')       energyProduct     = p
            if (p.id === 'energy_100_promo') energyProductPromo = p
        }
        updateBuyButtonPrice()
    } catch {}
}

// ===== BOOK DATA =====
async function loadBooksData() {
    const res = await fetch('data/books.json')
    const json = await res.json()
    booksData = json.books
}

async function loadAuthorsData() {
    const res = await fetch('data/authors.json')
    const json = await res.json()
    for (const a of json.authors) authorsMap[a.id] = a.name
}

// ===== PROGRESS SAVE / LOAD =====
async function loadProgress() {
    let cloudStats = null, cloudData = null
    let localStats = null, localData = null

    // Try cloud
    try {
        cloudStats = await player.getStats()
        cloudData  = await player.getData()
    } catch {}

    // Try local backup
    try {
        const ls = localStorage.getItem('bg2_stats')
        const ld = localStorage.getItem('bg2_data')
        if (ls) localStats = JSON.parse(ls)
        if (ld) localData  = JSON.parse(ld)
    } catch {}

    // Decide which source to use
    const hasCloud = cloudStats && typeof cloudStats.journeysCount !== 'undefined'
    const src = hasCloud ? { stats: cloudStats, data: cloudData } : { stats: localStats, data: localData }

    if (src.stats) {
        playerStats.scoreTotal       = src.stats.scoreTotal       || 0
        playerStats.journeysCount    = src.stats.journeysCount    || 0
        playerStats.winStreakCurrent = src.stats.winStreakCurrent  || 0
        playerStats.winStreakMax     = src.stats.winStreakMax      || 0
        playerStats.energy           = src.stats.energy           ?? 30
    } else {
        // First launch
        playerStats.energy = 30
        playerData.firstLaunchAt = ysdk.serverTime()
        playerData.lastEnergyRestoreTimestamp = ysdk.serverTime()
        await saveProgress()
        return
    }

    if (src.data) {
        playerData.saveVersion              = src.data.saveVersion              || SAVE_VERSION
        playerData.firstLaunchAt            = src.data.firstLaunchAt            || 0
        playerData.lastEnergyRestoreTimestamp = src.data.lastEnergyRestoreTimestamp || 0
        playerData.playedBookIds            = src.data.playedBookIds            || []
        playerData.currentRound             = src.data.currentRound             || null
    }
}

async function saveProgress() {
    const stats = { ...playerStats }
    const data  = { ...playerData }

    // Cloud
    try {
        await player.setStats(stats)
        await player.setData(data, true)
    } catch {}

    // Local backup
    try {
        localStorage.setItem('bg2_stats', JSON.stringify(stats))
        localStorage.setItem('bg2_data',  JSON.stringify(data))
    } catch {}
}

// ===== ENERGY =====
async function checkEnergyRestore() {
    const now = ysdk.serverTime()
    const elapsed = now - (playerData.lastEnergyRestoreTimestamp || now)
    if (elapsed >= RESTORE_INTERVAL_MS && playerStats.energy < RESTORE_THRESHOLD) {
        playerStats.energy = RESTORE_AMOUNT
        playerData.lastEnergyRestoreTimestamp = now
        await saveProgress()
        return true
    }
    return false
}

function getRestoreCountdown() {
    const now     = ysdk.serverTime()
    const elapsed = now - (playerData.lastEnergyRestoreTimestamp || now)
    const remaining = Math.max(0, RESTORE_INTERVAL_MS - elapsed)
    const h = Math.floor(remaining / 3_600_000)
    const m = Math.floor((remaining % 3_600_000) / 60_000)
    const s = Math.floor((remaining % 60_000) / 1_000)
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

// ===== PROMO =====
function checkPromoActive(flags, serverTime) {
    const startStr = flags.promostart
    const stopStr  = flags.promostop
    if (!startStr || !stopStr) return false
    try {
        const tz   = Intl.DateTimeFormat().resolvedOptions().timeZone
        const date = new Date(serverTime)
        const parts = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' })
                          .formatToParts(date)
        const get = type => parts.find(p => p.type === type)?.value || '01'
        const cur  = new Date(+get('year'), +get('month') - 1, +get('day'))
        const parse = str => { const [d,m,y] = str.split('.'); return new Date(+y, +m-1, +d) }
        return cur >= parse(startStr) && cur <= parse(stopStr)
    } catch {
        return false
    }
}

// ===== BOOK SELECTION =====
function selectNextBook() {
    const played = new Set(playerData.playedBookIds)
    let pool = booksData.filter(b => !played.has(b.id))
    if (!pool.length) {
        // Reset pool
        playerData.playedBookIds = []
        pool = booksData
    }
    return pool[Math.floor(Math.random() * pool.length)]
}

function computeStartFraction(totalLocations) {
    const total = totalLocations >= 3 ? totalLocations : 300
    const rangeStart = Math.floor(total / 3)
    const rangeEnd   = Math.floor(total / 3 * 2)
    const page = rangeStart + Math.floor(Math.random() * (rangeEnd - rangeStart + 1))
    return page / total
}

// ===== AUDIO =====
const sfx = {
    start:     null,
    tenSecond: null,
    _paused:   false,
    _active:   null,

    load() {
        try {
            this.start     = new Audio('sfx/start.mp3')
            this.tenSecond = new Audio('sfx/10second.mp3')
            this.start.load()
            this.tenSecond.load()
        } catch {}
    },

    play(name) {
        if (this._paused) return
        try {
            const snd = name === 'start' ? this.start : this.tenSecond
            if (!snd) return
            snd.currentTime = 0
            this._active = snd
            snd.play().catch(() => {})
        } catch {}
    },

    pause() {
        this._paused = true
        try { this._active?.pause() } catch {}
    },

    resume() {
        this._paused = false
    },
}

// ===== SEARCH =====
let searchIndex = []   // [{ id, title, authorName, combined }]

function buildSearchIndex() {
    searchIndex = booksData.map(book => ({
        id:         book.id,
        book:       book,
        title:      book.title.toLowerCase(),
        authorName: (authorsMap[book.author_id] || '').toLowerCase(),
        combined:   (book.title + ' ' + (authorsMap[book.author_id] || '')).toLowerCase(),
    }))
}

function searchBooks(query) {
    if (!query || query.length < 2) return []
    const q = query.toLowerCase().trim()
    return searchIndex
        .filter(e => e.combined.includes(q) || e.title.includes(q) || e.authorName.includes(q))
        .slice(0, 12)
        .map(e => e.book)
}

// ===== ROUND TIMER =====
function startRoundTimer() {
    roundTimeLeft = ROUND_DURATION
    updateTimerDisplay()
    sfx.play('start')

    roundTimerHandle = setInterval(() => {
        if (adInProgress) return   // freeze while ad is showing
        roundTimeLeft--
        updateTimerDisplay()
        if (roundTimeLeft === 10) {
            document.getElementById('timer-display').classList.add('urgent')
            sfx.play('tenSecond')
        }
        if (roundTimeLeft <= 0) {
            clearInterval(roundTimerHandle)
            roundTimerHandle = null
            onTimeExpired()
        }
    }, 1000)
}

function stopRoundTimer() {
    if (roundTimerHandle) {
        clearInterval(roundTimerHandle)
        roundTimerHandle = null
    }
}

function updateTimerDisplay() {
    const el = document.getElementById('timer-display')
    if (!el) return
    const m = Math.floor(roundTimeLeft / 60)
    const s = roundTimeLeft % 60
    el.textContent = `${m}:${String(s).padStart(2,'0')}`
}

// ===== GAMEPLAY MARKUP =====
function gameplayStart() {
    if (gameplayActive) return
    gameplayActive = true
    try { ysdk.features.GameplayAPI.start() } catch {}
}

function gameplayStop() {
    if (!gameplayActive) return
    gameplayActive = false
    try { ysdk.features.GameplayAPI.stop() } catch {}
}

function onGamePause() {
    adInProgress = true
    sfx.pause()
}

function onGameResume() {
    adInProgress = false
    sfx.resume()
}

// ===== PURCHASES =====
async function checkUnprocessedPurchases() {
    if (!payments) return
    try {
        const purchases = await payments.getPurchases()
        for (const p of purchases) {
            if (p.productID === 'energy_100' || p.productID === 'energy_100_promo') {
                playerStats.energy += PURCHASE_ENERGY
                await saveProgress()
                await payments.consumePurchase(p.purchaseToken)
            }
        }
    } catch {}
}

async function buyEnergy() {
    if (!payments) return
    const productId = promoActive ? 'energy_100_promo' : 'energy_100'
    try {
        const purchase = await payments.purchase({ id: productId })
        playerStats.energy += PURCHASE_ENERGY
        await saveProgress()
        try { await payments.consumePurchase(purchase.purchaseToken) } catch {}
        updateEnergyDisplay()
        updateModalEnergyDisplay()
        updateBuyButtonPrice()
    } catch (e) {
        // User cancelled or purchase failed — not an error
        console.log('Purchase cancelled or failed:', e)
    }
}

// ===== COVER EXTRACTION =====
async function extractCoverFromFB2(url) {
    try {
        const res  = await fetch(url)
        const text = await res.text()
        const parser = new DOMParser()
        const doc  = parser.parseFromString(text, 'application/xml')
        const coverImg = doc.querySelector('coverpage image')
        if (!coverImg) return null
        const href = coverImg.getAttribute('l:href')
                  || coverImg.getAttribute('xlink:href')
                  || coverImg.getAttribute('href')
        if (!href) return null
        const binaryId = href.startsWith('#') ? href.slice(1) : href
        const binary   = doc.querySelector(`binary[id="${CSS.escape(binaryId)}"]`)
                      || Array.from(doc.querySelectorAll('binary')).find(b => b.getAttribute('id') === binaryId)
        if (!binary) return null
        const ct     = binary.getAttribute('content-type') || 'image/jpeg'
        const b64    = binary.textContent.trim().replace(/\s/g, '')
        return `data:${ct};base64,${b64}`
    } catch {
        return null
    }
}

// ===== ROUND FLOW =====
async function startRound(retryState) {
    gameplayStop()

    let book, fraction

    if (retryState) {
        // Same book, same page
        book     = booksData.find(b => b.id === retryState.bookId)
        fraction = retryState.startFraction
    } else {
        book = selectNextBook()
        fraction = 1/3 + Math.random() * 1/3
    }

    currentRound = {
        bookId:        book.id,
        startFraction: fraction,
        startedAt:     ysdk.serverTime(),
        isRetry:       !!retryState,
    }

    // Save round state in case of crash
    playerData.currentRound = { ...currentRound }
    if (!retryState) {
        playerStats.journeysCount++
        playerStats.energy = Math.max(0, playerStats.energy - ENERGY_COST)
    }
    await saveProgress()

    selectedBook = null
    updateEnergyDisplay()

    showRoundLoadingScreen()

    // Load reader in hidden iframe first, get sections
    await loadReaderAndNavigate(book, fraction)
}

function waitForReaderMessage(type, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            window.removeEventListener('message', handler)
            reject(new Error('Reader timeout: ' + type))
        }, timeoutMs)
        function handler(e) {
            if (!e.data || typeof e.data !== 'object') return
            if (e.data.type === 'bookLoadError') {
                clearTimeout(timer)
                window.removeEventListener('message', handler)
                reject(new Error('Book load error: ' + e.data.message))
                return
            }
            if (e.data.type === type) {
                clearTimeout(timer)
                window.removeEventListener('message', handler)
                resolve(e.data)
            }
        }
        window.addEventListener('message', handler)
    })
}

async function loadReaderAndNavigate(book, fraction) {
    const iframe = document.getElementById('reader-iframe')
    // Pass just the filename — reader builds the absolute path to avoid encoding issues
    const readerUrl = `reader/reader.html?file=${encodeURIComponent(book.file)}&game=1&fraction=${fraction}`

    iframe.src = readerUrl

    try {
        await waitForReaderMessage('bookLoaded')
        // Short pause for rendering
        await sleep(800)
    } catch (e) {
        console.warn('Reader loading issue:', e)
        // Continue anyway — reader may still be usable
    }

    showRoundScreen()
    startRoundTimer()
    gameplayStart()
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function onTimeExpired() {
    gameplayStop()
    stopRoundTimer()
    sfx.pause()

    const book = booksData.find(b => b.id === currentRound.bookId)

    // Streak broken
    const hadStreak = playerStats.winStreakCurrent > 0
    playerStats.winStreakCurrent = 0

    playerData.currentRound = null
    if (book) markBookPlayed(book.id)
    await saveProgress()

    showResultsScreen({ type: 'fail', baseScore: 0, roundScore: 0, hadStreak, book })
}

async function onConfirmAnswer() {
    if (!selectedBook) return
    stopRoundTimer()
    gameplayStop()

    const targetBook = booksData.find(b => b.id === currentRound.bookId)
    const result = calculateRoundResult(targetBook, selectedBook)

    // Apply streak
    const wasStreak    = playerStats.winStreakCurrent
    const hadStreak    = playerStats.winStreakCurrent > 0
    let hadStreakBroken = false

    if (result.type === 'fail') {
        if (hadStreak) hadStreakBroken = true
        playerStats.winStreakCurrent = 0
    } else {
        playerStats.winStreakCurrent++
        if (playerStats.winStreakCurrent > playerStats.winStreakMax) {
            playerStats.winStreakMax = playerStats.winStreakCurrent
        }
    }

    // Compute final score
    const streak     = playerStats.winStreakCurrent  // already updated
    const multiplier = computeMultiplier(streak)
    const roundScore = Math.floor(result.baseScore * multiplier)
    playerStats.scoreTotal += roundScore

    if (targetBook) markBookPlayed(targetBook.id)
    playerData.currentRound = null
    await saveProgress()

    // Show fullscreen ad
    await showFullscreenAd()

    showResultsScreen({
        type:     result.type,
        baseScore:   result.baseScore,
        roundScore,
        multiplier,
        streak,
        hadStreakBroken,
        book:     targetBook,
    })
}

function calculateRoundResult(targetBook, selectedBook) {
    if (!targetBook || !selectedBook) return { type: 'fail', baseScore: 0 }

    if (selectedBook.id === targetBook.id) {
        return { type: 'book', baseScore: 100 }
    }
    if (selectedBook.author_id === targetBook.author_id) {
        return { type: 'author', baseScore: 50 }
    }
    if (selectedBook.origin_country && selectedBook.origin_country === targetBook.origin_country
        && targetBook.origin_country !== 11) {
        return { type: 'country', baseScore: 25 }
    }
    if (Math.abs((selectedBook.publication_year || 0) - (targetBook.publication_year || 0)) < 31) {
        return { type: 'era', baseScore: 25 }
    }
    return { type: 'fail', baseScore: 0 }
}

function computeMultiplier(streakLen) {
    if (streakLen <= 1) return 1
    return 1 + streakLen / 10
}

function markBookPlayed(bookId) {
    if (!playerData.playedBookIds.includes(bookId)) {
        playerData.playedBookIds.push(bookId)
    }
    if (playerData.playedBookIds.length >= booksData.length) {
        playerData.playedBookIds = []
    }
}

// ===== ADS =====
function showFullscreenAd() {
    return new Promise(resolve => {
        adInProgress = true
        sfx.pause()
        gameplayStop()
        try {
            ysdk.adv.showFullscreenAdv({
                callbacks: {
                    onClose:  () => { adInProgress = false; sfx.resume(); resolve() },
                    onError:  (e) => { adInProgress = false; sfx.resume(); resolve() },
                    onOffline:() => { adInProgress = false; sfx.resume(); resolve() },
                },
            })
        } catch {
            adInProgress = false
            sfx.resume()
            resolve()
        }
    })
}

function showRewardedVideo(onRewarded) {
    adInProgress = true
    sfx.pause()
    gameplayStop()
    try {
        ysdk.adv.showRewardedVideo({
            callbacks: {
                onRewarded: () => { onRewarded?.() },
                onClose:    () => { adInProgress = false; sfx.resume() },
                onError:    () => { adInProgress = false; sfx.resume() },
            },
        })
    } catch {
        adInProgress = false
        sfx.resume()
    }
}

// ===== SCREEN MANAGEMENT =====
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
    const el = document.getElementById(id)
    if (el) el.classList.add('active')
}

function showMainScreen() {
    // Re-check energy restore
    checkEnergyRestore().then(() => {
        updateStatsDisplay()
        updatePromoDisplay()
        document.getElementById('btn-play').disabled = playerStats.energy < ENERGY_COST
        showScreen('screen-main')
        gameplayStop()
    })
}

function showRoundLoadingScreen() {
    showScreen('screen-round-loading')
}

function showRoundScreen() {
    // Clear previous search state
    document.getElementById('search-input').value = ''
    document.getElementById('search-dropdown').classList.remove('open')
    document.getElementById('search-dropdown').innerHTML = ''
    document.getElementById('btn-confirm').classList.add('hidden')
    document.getElementById('selected-book-label').classList.add('hidden')
    document.getElementById('btn-search-clear').classList.add('hidden')
    document.getElementById('timer-display').classList.remove('urgent')
    selectedBook = null

    showScreen('screen-round')
    document.getElementById('reader-iframe').focus()
}

function showResultsScreen(result) {
    renderResultsBanner(result)
    renderResultsStats()
    renderResultsActions(result)
    showScreen('screen-results')
}

function showAnswerScreen(book) {
    if (!book) { showMainScreen(); return }

    document.getElementById('answer-book-title').textContent  = book.title
    document.getElementById('answer-book-author').textContent = authorsMap[book.author_id] || ''
    document.getElementById('answer-book-year').textContent   = book.publication_year
        ? `${book.publication_year} г.` : ''

    // Try to show cover
    const coverWrap = document.getElementById('answer-cover-wrap')
    const coverImg  = document.getElementById('answer-cover')
    coverWrap.classList.add('hidden')
    extractCoverFromFB2(`data/files/${book.file}`).then(src => {
        if (src) {
            coverImg.src = src
            coverWrap.classList.remove('hidden')
        }
    })

    updateAnswerScreenStats()
    showScreen('screen-answer')
}

// ===== RENDER HELPERS =====
function updateStatsDisplay() {
    const s = playerStats
    setText('stat-score',      formatNumber(s.scoreTotal))
    setText('stat-journeys',   formatNumber(s.journeysCount))
    setText('stat-streak-max', formatNumber(s.winStreakMax))
    setText('stat-energy',     formatNumber(s.energy))
}

function updateEnergyDisplay() {
    setText('stat-energy', formatNumber(playerStats.energy))
    setText('res-stat-energy', formatNumber(playerStats.energy))
    setText('ans-stat-energy', formatNumber(playerStats.energy))
}

function updatePromoDisplay() {
    toggleClass('promo-badge-main', 'hidden', !promoActive)
    toggleClass('res-promo-badge',  'hidden', !promoActive)
    toggleClass('ans-promo-badge',  'hidden', !promoActive)
}

function updateAnswerScreenStats() {
    setText('ans-stat-score',  formatNumber(playerStats.scoreTotal))
    setText('ans-stat-energy', formatNumber(playerStats.energy))
    updatePromoDisplay()
    document.getElementById('btn-answer-play').disabled = playerStats.energy < ENERGY_COST
}

function renderResultsBanner(result) {
    const banner = document.getElementById('results-banner')
    banner.className = 'results-banner result-' + result.type

    // Icon
    const iconEl = document.getElementById('results-icon')
    const icons = {
        book:    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor"/></svg>',
        author:  '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/><path d="M4 20c0-4 3.58-7 8-7s8 3 8 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        country: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        era:     '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        fail:    '<svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/></svg>',
    }
    iconEl.innerHTML = icons[result.type] || icons.fail

    // Title
    const titles = {
        book:    'Поздравляем! Вы угадали книгу!',
        author:  'Отлично! Вы угадали автора!',
        country: 'Хорошо! Вы угадали страну книги!',
        era:     'Неплохо! Вы угадали эпоху книги!',
        fail:    'Увы, не угадали...',
    }
    setText('results-title', titles[result.type])

    // Score block
    const scoreBlock = document.getElementById('results-score-block')
    const streakBlock = document.getElementById('results-streak-block')
    const streakBroken = document.getElementById('results-streak-broken')

    if (result.type === 'fail') {
        scoreBlock.classList.add('hidden')
    } else {
        scoreBlock.classList.remove('hidden')
        setText('results-base-score', '+' + result.baseScore)

        if (result.multiplier && result.multiplier > 1) {
            streakBlock.classList.remove('hidden')
            setText('results-streak-len', result.streak)
            setText('results-multiplier', '×' + result.multiplier.toFixed(1))
            setText('results-bonus-score', '+' + (result.roundScore - result.baseScore))
            setText('results-final-score', '+' + result.roundScore)
        } else {
            streakBlock.classList.add('hidden')
        }
    }

    // Streak broken
    if (result.hadStreakBroken) {
        streakBroken.classList.remove('hidden')
    } else {
        streakBroken.classList.add('hidden')
    }
}

function renderResultsStats() {
    setText('res-stat-score',    formatNumber(playerStats.scoreTotal))
    setText('res-stat-journeys', formatNumber(playerStats.journeysCount))
    setText('res-stat-streak',   formatNumber(playerStats.winStreakCurrent))
    setText('res-stat-energy',   formatNumber(playerStats.energy))
    updatePromoDisplay()
}

function renderResultsActions(result) {
    const container = document.getElementById('results-actions')
    container.innerHTML = ''

    const canPlay = playerStats.energy >= ENERGY_COST

    if (result.type === 'book') {
        // Success: Play more + Menu
        addButton(container, 'btn-primary', 'Играть дальше', () => {
            if (playerStats.energy >= ENERGY_COST) startRound(null)
            else openEnergyModal()
        }, !canPlay)
        addButton(container, 'btn-secondary', 'Вернуться в главное меню', showMainScreen)

    } else if (result.type === 'author' || result.type === 'era' || result.type === 'country') {
        // Partial success
        addButton(container, 'btn-primary', 'Попробовать еще раз (видео)', () => {
            const retryState = { ...currentRound }
            showRewardedVideo(() => {
                startRound(retryState)
            })
        })
        addButton(container, 'btn-secondary', 'Показать правильный ответ', () => showAnswerScreen(result.book))
        addButton(container, 'btn-secondary', 'Вернуться в главное меню', showMainScreen)

    } else {
        // Fail
        addButton(container, 'btn-primary', 'Попробовать еще раз (видео)', () => {
            const retryState = { ...currentRound }
            showRewardedVideo(() => {
                startRound(retryState)
            })
        })
        addButton(container, 'btn-secondary', 'Показать правильный ответ', () => showAnswerScreen(result.book))
        addButton(container, 'btn-secondary', 'Вернуться в главное меню', showMainScreen)
    }
}

function addButton(container, cls, text, onClick, disabled = false) {
    const btn = document.createElement('button')
    btn.className = cls
    btn.textContent = text
    btn.disabled = disabled
    btn.addEventListener('click', onClick)
    container.appendChild(btn)
}

// ===== ENERGY MODAL =====
async function openEnergyModal() {
    await checkEnergyRestore()
    updateModalEnergyDisplay()
    updateBuyButtonPrice()

    // Start countdown if needed
    startModalCountdown()

    document.getElementById('modal-energy').classList.remove('hidden')
}

function closeEnergyModal() {
    document.getElementById('modal-energy').classList.add('hidden')
    if (energyModalCountdownHandle) {
        clearInterval(energyModalCountdownHandle)
        energyModalCountdownHandle = null
    }
}

function updateModalEnergyDisplay() {
    setText('modal-energy-value', formatNumber(playerStats.energy))

    const restoreBlock = document.getElementById('modal-restore-block')
    if (playerStats.energy < RESTORE_THRESHOLD) {
        restoreBlock.classList.remove('hidden')
        setText('modal-restore-countdown', getRestoreCountdown())
    } else {
        restoreBlock.classList.add('hidden')
    }
}

function startModalCountdown() {
    if (energyModalCountdownHandle) clearInterval(energyModalCountdownHandle)
    if (playerStats.energy >= RESTORE_THRESHOLD) return

    energyModalCountdownHandle = setInterval(() => {
        checkEnergyRestore().then(restored => {
            if (restored) updateStatsDisplay()
            updateModalEnergyDisplay()
        })
    }, 1000)
}

function updateBuyButtonPrice() {
    const product = promoActive ? energyProductPromo : energyProduct
    const priceEl = document.getElementById('btn-buy-price')
    if (product && priceEl) {
        priceEl.textContent = product.price || ''
    }
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
    sfx.load()

    // Main screen
    document.getElementById('btn-play').addEventListener('click', () => {
        if (playerStats.energy >= ENERGY_COST) startRound(null)
        else openEnergyModal()
    })
    document.getElementById('btn-energy-plus-main').addEventListener('click', openEnergyModal)

    // Energy modal
    document.getElementById('btn-energy-modal-close').addEventListener('click', closeEnergyModal)
    document.getElementById('modal-energy').addEventListener('click', e => {
        if (e.target === document.getElementById('modal-energy')) closeEnergyModal()
    })
    document.getElementById('btn-buy-energy').addEventListener('click', buyEnergy)
    document.getElementById('btn-watch-video').addEventListener('click', () => {
        closeEnergyModal()
        showRewardedVideo(() => {
            playerStats.energy += REWARDED_ENERGY
            saveProgress()
            updateEnergyDisplay()
        })
    })

    // Energy modal openers (results / answer screens)
    document.querySelectorAll('.open-energy-modal').forEach(btn => {
        btn.addEventListener('click', openEnergyModal)
    })

    // Answer screen
    document.getElementById('btn-answer-play').addEventListener('click', () => {
        if (playerStats.energy >= ENERGY_COST) startRound(null)
        else openEnergyModal()
    })
    document.getElementById('btn-answer-menu').addEventListener('click', showMainScreen)

    // Search
    const searchInput    = document.getElementById('search-input')
    const searchDropdown = document.getElementById('search-dropdown')
    const clearBtn       = document.getElementById('btn-search-clear')

    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim()
        clearBtn.classList.toggle('hidden', !q)
        renderSearchDropdown(searchBooks(q))
    })

    clearBtn.addEventListener('click', () => {
        searchInput.value = ''
        clearBtn.classList.add('hidden')
        searchDropdown.classList.remove('open')
        searchDropdown.innerHTML = ''
        selectedBook = null
        document.getElementById('btn-confirm').classList.add('hidden')
        document.getElementById('selected-book-label').classList.add('hidden')
    })

    // Confirm
    document.getElementById('btn-confirm').addEventListener('click', onConfirmAnswer)

    // Close dropdown on outside click
    document.addEventListener('click', e => {
        if (!e.target.closest('.search-container')) {
            searchDropdown.classList.remove('open')
        }
    })
}

function renderSearchDropdown(results) {
    const dropdown = document.getElementById('search-dropdown')
    dropdown.innerHTML = ''

    if (!results.length) {
        const q = document.getElementById('search-input').value.trim()
        if (q.length >= 2) {
            dropdown.innerHTML = '<div class="search-no-results">Ничего не найдено</div>'
            dropdown.classList.add('open')
        } else {
            dropdown.classList.remove('open')
        }
        return
    }

    dropdown.classList.add('open')

    results.forEach(book => {
        const item = document.createElement('div')
        item.className = 'search-item'
        item.setAttribute('role', 'option')

        const titleEl = document.createElement('div')
        titleEl.className = 'search-item-title'
        titleEl.textContent = book.title

        const authorEl = document.createElement('div')
        authorEl.className = 'search-item-author'
        authorEl.textContent = authorsMap[book.author_id] || ''

        item.appendChild(titleEl)
        item.appendChild(authorEl)

        item.addEventListener('click', () => {
            selectBookFromSearch(book)
            dropdown.classList.remove('open')
        })

        dropdown.appendChild(item)
    })
}

function selectBookFromSearch(book) {
    selectedBook = book
    const authorName = authorsMap[book.author_id] || ''
    const label = document.getElementById('selected-book-label')
    label.textContent = `${book.title} — ${authorName}`
    label.classList.remove('hidden')

    document.getElementById('search-input').value = book.title
    document.getElementById('btn-search-clear').classList.remove('hidden')
    document.getElementById('btn-confirm').classList.remove('hidden')
    document.getElementById('search-dropdown').classList.remove('open')
}

// ===== UTILITIES =====
function detectDevice() {
    let isMobile = false
    try {
        if (ysdk && ysdk.deviceInfo) {
            isMobile = ysdk.deviceInfo.isMobile() || ysdk.deviceInfo.type === 'mobile' || ysdk.deviceInfo.type === 'tablet'
        } else {
            isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent)
        }
    } catch {
        isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent)
    }
    if (isMobile) {
        document.body.classList.add('is-mobile')
    }
}

function setText(id, text) {
    const el = document.getElementById(id)
    if (el) el.textContent = text
}

function toggleClass(id, cls, condition) {
    const el = document.getElementById(id)
    if (el) el.classList.toggle(cls, condition)
}

function formatNumber(n) {
    return (n || 0).toLocaleString('ru-RU')
}

// ===== BOOT =====
init().catch(e => console.error('Game init error:', e))
