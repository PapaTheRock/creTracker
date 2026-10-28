const CONFIG_KEY = 'creatine_config';
const HISTORY_KEY = 'creatine_history';

document.addEventListener('DOMContentLoaded', () => {
    initServiceWorker();
    loadConfiguration();
    loadHistory();
    showInitialStatus();

    document.getElementById('enableNotifications').addEventListener('click', enableNotifications);
    document.getElementById('reminderForm').addEventListener('submit', saveConfiguration);
    document.getElementById('logIntake').addEventListener('click', logCurrentIntake);

    // Event delegation for deleting individual log rows
    const historyTable = document.getElementById('allEntries');
    if (historyTable) {
        historyTable.addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('.delete-btn');
            if (deleteBtn) {
                const id = deleteBtn.getAttribute('data-id');
                if (id) deleteEntry(id);
            }
        });
    }

    setupModalEvents();
});

/* ---------- helpers ---------- */

function readJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
        return fallback;
    }
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function setStatus(message, isError = false) {
    const el = document.getElementById('statusMessage');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', isError);
}

function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
    return window.navigator.standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches;
}

function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function currentFormConfig() {
    const dosage = document.getElementById('dosage').value || '5';
    const time = document.getElementById('reminderTime').value || '09:00';
    const days = Array.from(document.querySelectorAll('input[name="days"]:checked')).map((cb) => cb.value);
    return { dosage, time, days };
}

/* ---------- service worker + push ---------- */

function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js')
        .then(() => refreshSubscription())
        .catch((err) => console.error('Service Worker Registration Failed:', err));
}

function showInitialStatus() {
    if (isIOS() && !isStandalone()) {
        setStatus('On iPhone: tap Share, then "Add to Home Screen", and open the app from the new icon to enable notifications.', true);
    } else if (!pushSupported()) {
        setStatus('This browser does not support push notifications.', true);
    }
}

// Keeps the server's copy of the subscription fresh each time the app opens.
async function refreshSubscription() {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    try {
        const sub = await ensureSubscription();
        const config = readJson(CONFIG_KEY, null);
        if (config) await sendSubscriptionToServer(sub, config);
    } catch (err) {
        console.error('Subscription refresh failed:', err);
    }
}

async function ensureSubscription() {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) return sub;

    const res = await fetch('/api/vapid-public-key');
    if (!res.ok) throw new Error('Could not load push key from server');
    const { key } = await res.json();
    if (!key) throw new Error('Server has no VAPID key configured');

    return reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
    });
}

async function sendSubscriptionToServer(sub, config) {
    const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            subscription: sub.toJSON(),
            config,
            tz: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
    });
    if (!res.ok) throw new Error('Server rejected the reminder settings');
}

async function cacheConfigForWorker(config) {
    try {
        const cache = await caches.open('creatine-config');
        await cache.put('/__config', new Response(JSON.stringify(config), {
            headers: { 'Content-Type': 'application/json' }
        }));
    } catch (err) {
        console.error('Could not cache config for the service worker:', err);
    }
}

async function enableNotifications() {
    if (isIOS() && !isStandalone()) {
        setStatus('Open this app from the Home Screen icon first (Share > Add to Home Screen), then tap this button.', true);
        return;
    }
    if (!pushSupported()) {
        setStatus('This browser does not support push notifications.', true);
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            setStatus('Notifications are blocked. Allow them for this app in your device settings, then try again.', true);
            return;
        }

        const sub = await ensureSubscription();
        const config = readJson(CONFIG_KEY, null) || currentFormConfig();
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
        await cacheConfigForWorker(config);
        await sendSubscriptionToServer(sub, config);

        // Ask the server to send a real push so the whole chain is proven to work.
        const test = await fetch('/api/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint })
        });
        if (test.ok) {
            setStatus('Notifications enabled. A test notification is on its way.');
        } else {
            const info = await test.json().catch(() => ({}));
            const reason = info.error || ('push service replied ' + info.status + (info.detail ? ': ' + info.detail : ''));
            setStatus('Subscribed, but the test push failed (' + reason + ')', true);
        }
    } catch (err) {
        console.error(err);
        setStatus('Could not enable notifications: ' + err.message, true);
    }
}

/* ---------- configuration ---------- */

async function saveConfiguration(e) {
    e.preventDefault();
    const config = currentFormConfig();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    await cacheConfigForWorker(config);

    if (!pushSupported() || Notification.permission !== 'granted') {
        setStatus('Settings saved on this device. Tap "Enable Notifications" so reminders can be delivered.', true);
        return;
    }

    try {
        const sub = await ensureSubscription();
        await sendSubscriptionToServer(sub, config);
        setStatus('Reminder saved and active.');
    } catch (err) {
        console.error(err);
        setStatus('Saved locally, but the server could not be reached: ' + err.message, true);
    }
}

function loadConfiguration() {
    const config = readJson(CONFIG_KEY, null);
    if (!config) return;

    document.getElementById('dosage').value = config.dosage;
    document.getElementById('reminderTime').value = config.time;

    document.querySelectorAll('input[name="days"]').forEach((cb) => {
        cb.checked = Array.isArray(config.days) && config.days.includes(cb.value);
    });
}

/* ---------- history ---------- */

function logCurrentIntake() {
    const dosage = document.getElementById('dosage').value || '5';
    const now = new Date();

    const entry = {
        id: crypto.randomUUID ? crypto.randomUUID() : 'id_' + now.getTime() + '_' + Math.random().toString(36).slice(2, 6),
        dosage: `${dosage}g`,
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        date: now.toLocaleDateString([], { month: 'short', day: 'numeric' })
    };

    const history = readJson(HISTORY_KEY, []);
    history.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    loadHistory();
}

function deleteEntry(id) {
    const history = readJson(HISTORY_KEY, []).filter((item) => item.id !== id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    loadHistory();
}

function setupModalEvents() {
    const clearAllBtn = document.getElementById('clearAllLogs');
    const modalOverlay = document.getElementById('confirmationModal');
    const cancelClearBtn = document.getElementById('cancelClearBtn');
    const confirmClearBtn = document.getElementById('confirmClearBtn');

    if (!clearAllBtn || !modalOverlay) return;

    clearAllBtn.addEventListener('click', () => {
        if (readJson(HISTORY_KEY, []).length === 0) return;
        modalOverlay.classList.add('active');
    });

    cancelClearBtn?.addEventListener('click', () => {
        modalOverlay.classList.remove('active');
    });

    confirmClearBtn?.addEventListener('click', () => {
        localStorage.removeItem(HISTORY_KEY);
        modalOverlay.classList.remove('active');
        loadHistory();
    });

    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) modalOverlay.classList.remove('active');
    });
}

function loadHistory() {
    const history = readJson(HISTORY_KEY, []);
    const tbody = document.getElementById('historyBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (history.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding: 16px;">No logs yet.</td></tr>';
        return;
    }

    history.forEach((entry) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${escapeHtml(entry.dosage)}</strong></td>
            <td>${escapeHtml(entry.time)}</td>
            <td>${escapeHtml(entry.date)}</td>
            <td style="text-align: center;">
                <button class="delete-btn" data-id="${escapeHtml(entry.id)}">✗</button>
            </td>
        `;
        tbody.appendChild(row);
    });
}
