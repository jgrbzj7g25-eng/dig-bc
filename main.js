// ==UserScript==
// @name         DIG BC
// @namespace    http://violentmonkey.net/
// @version      1.59
// @match        https://*.bandcamp.com/album/*
// @match        https://*.bandcamp.com/track/*
// @match        https://bandcamp.com/*
// @match        https://bandcamp.com/*/wishlist
// @match        https://bandcamp.com/*/collection
// @grant        none
// @license      MIT
// @description  Extends Bandcamp with improved player controls, keyboard shortcuts, wishlist actions, BPM tap tempo, and speed adjustment.
// @author       bloxb
// @downloadURL https://update.greasyfork.org/scripts/579568/DIG%20BC.user.js
// @updateURL https://update.greasyfork.org/scripts/579568/DIG%20BC.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const SEEK_SMALL = 30;
    const SEEK_LARGE = 60;
    const VOL_STEP = 0.05;
    const VOL_KEY = 'bcp_volume';
    const MUTE_KEY = 'bcp_muted';
    const SPEED_KEY = 'bcp_speed';
    const PRESERVE_PITCH_KEY = 'bcp_preserve_pitch';
    const TICK_MS = 500;

    const TAP_RESET_MS = 2500;
    const TAP_MAX_SAMPLES = 8;

    const SPEED_MIN = 0.5;
    const SPEED_MAX = 1.5;
    const SPEED_STEP = 0.05;
    const SPEED_DEFAULT = 1.0;

    let controls = null;
    let lastTagStr = '';
    let lastAlbumStr = '';
    let lastMetaText = '';
    let lastTitleText = '';

    let preloadDone = false;
    let preloadReady = false;

    let shortcutsOverlay = null;

    let bpmTapTimes = [];
    let bpmTapResetTimer = null;
    let currentTappedBpm = null;

    function getAudio() {
        return document.querySelector('audio');
    }

    function getNativeBtn(sel) {
        return document.querySelector(sel);
    }

    function fmt(s) {
        if (!isFinite(s) || isNaN(s)) return '0:00';
        s = Math.floor(s);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    function fmtSpeed(v) {
        return `${Number(v).toFixed(2)}x`;
    }

    function seekRelative(sec) {
        const a = getAudio();
        if (!a) return;
        a.currentTime = Math.max(0, Math.min(a.duration || Infinity, a.currentTime + sec));
    }

    function cleanText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    function stripTrailingDuration(text) {
        return cleanText(text).replace(/\s+\d{1,2}:\d{2}(?::\d{2})?$/, '');
    }

    function isTrackPage() {
        return /\/track\//.test(window.location.pathname);
    }

    function isCollectionPage() {
        return /\/(wishlist|collection)/.test(window.location.pathname) || /^\/[^/]+$/.test(window.location.pathname);
    }

    function hasMultipleTracks() {
        const tracks = getAllTracks().filter(Boolean);
        return tracks.length > 1;
    }

    function isCloseOverlayKey(event) {
        return event.key === 'Escape' ||
               event.key === 'Esc' ||
               event.code === 'Escape' ||
               event.keyCode === 27 ||
               event.key === 'CapsLock' ||
               event.code === 'CapsLock';
    }

    function isElementVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function isTypingTarget(el) {
        if (!el || !el.tagName) return false;

        if (el.isContentEditable) return true;

        const tag = el.tagName.toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;

        if (typeof el.closest === 'function') {
            // Check if element or any parent has these attributes/classes
            if (el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], .search, .search-field, .search_input, .site-search-form, [type="search"], .search-instant-inline')) {
                return true;
            }

            // Check if we're inside a search form
            if (el.closest('form.site-search-form') || el.closest('[role="search"]')) {
                return true;
            }
        }

        // Direct check for input elements
        if (tag === 'INPUT' && (el.type === 'text' || el.type === 'search' || el.type === 'email' || el.type === 'password')) {
            return true;
        }

        return false;
    }

    function getRealActiveElement() {
        let el = document.activeElement;
        while (el && el.shadowRoot && el.shadowRoot.activeElement) {
            el = el.shadowRoot.activeElement;
        }
        return el;
    }

    function isTypingEvent(e) {
        if (!e) return false;
        const activeEl = getRealActiveElement();
        if (isTypingTarget(activeEl)) return true;

        if (e.composedPath) {
            const path = e.composedPath();
            for (const el of path) {
                if (isTypingTarget(el)) return true;
            }
        }

        return isTypingTarget(e.target) || isTypingTarget(document.activeElement);
    }

    async function copyToClipboard(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) {}

        try {
            const tempInput = document.createElement('input');
            tempInput.value = text;
            document.body.appendChild(tempInput);
            tempInput.select();
            tempInput.setSelectionRange(0, tempInput.value.length);
            const ok = document.execCommand('copy');
            document.body.removeChild(tempInput);
            return ok;
        } catch (e) {
            return false;
        }
    }

    function getPlayerHeight() {
        const bar = document.getElementById('bc-sticky-player');
        return bar ? Math.ceil(bar.getBoundingClientRect().height) : 88;
    }

    function showPopup(message) {
        const popup = document.createElement('div');
        popup.textContent = message;
        popup.style.position = 'fixed';
        popup.style.bottom = `${getPlayerHeight() + 12}px`;
        popup.style.right = '10px';
        popup.style.padding = '10px';
        popup.style.backgroundColor = '#f7f7f7';
        popup.style.color = '#222';
        popup.style.border = '1px solid #cfd6dc';
        popup.style.borderRadius = '5px';
        popup.style.boxShadow = '0 2px 10px rgba(0,0,0,0.08)';
        popup.style.zIndex = '1000001';
        popup.style.fontSize = '14px';
        popup.style.maxWidth = '420px';
        popup.style.wordBreak = 'break-word';
        document.body.appendChild(popup);
        setTimeout(() => popup.remove(), 2000);
    }

    function ensureShortcutsOverlay() {
        if (shortcutsOverlay) return;

        shortcutsOverlay = document.createElement('div');
        shortcutsOverlay.id = 'bcp-shortcuts-overlay';
        shortcutsOverlay.innerHTML = `
            <div id="bcp-shortcuts-backdrop"></div>
            <div id="bcp-shortcuts-modal">
                <div id="bcp-shortcuts-header">
                    <span>Bandcamp Player Shortcuts</span>
                    <button id="bcp-shortcuts-close" type="button">✕</button>
                </div>
                <div id="bcp-shortcuts-body">
                    <div class="bcp-shortcut-row"><span class="bcp-k">Space</span><span>Play / Pause</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">Shift + Space</span><span>Scroll down</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">↑</span><span>Previous track</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">↓</span><span>Next track</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">Shift + ↑ / ↓</span><span>Volume up / down</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">← / →</span><span>Seek ±30s</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">Shift + ← / →</span><span>Seek ±60s</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">C</span><span>Copy current track as “Title - Artist”</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">F</span><span>Open current track page</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">W</span><span>Add current item to wishlist</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">Shift + W</span><span>Remove current item from wishlist</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">? / ß</span><span>Show this shortcuts help</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">Escape / CapsLock</span><span>Close help / dropdown</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">Click BPM</span><span>Tap tempo</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">Speed slider</span><span>Adjust playback speed from 0.5x to 1.5x</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">Double-click speed label</span><span>Reset speed to 1.00x</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">PP toggle</span><span>Toggle preserve pitch if supported</span></div>
                    <div class="bcp-shortcut-row"><span class="bcp-k">HELP</span><span>Open this shortcuts help</span></div>
                </div>
            </div>
        `;

        const style = document.createElement('style');
        style.textContent = `
            #bcp-shortcuts-overlay {
                position: fixed;
                inset: 0;
                z-index: 1000000;
                display: none;
            }
            #bcp-shortcuts-overlay.open {
                display: block;
            }
            #bcp-shortcuts-backdrop {
                position: absolute;
                inset: 0;
                background: rgba(0, 0, 0, 0.45);
            }
            #bcp-shortcuts-modal {
                position: absolute;
                left: 50%;
                top: 50%;
                transform: translate(-50%, -50%);
                width: min(680px, 92vw);
                max-height: 80vh;
                overflow: auto;
                background: #f7f7f7;
                border: 1px solid #cfd6dc;
                border-radius: 8px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.18);
                font-family: Helvetica, Arial, sans-serif;
                color: #223;
            }
            #bcp-shortcuts-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 14px;
                border-bottom: 1px solid #d8dee3;
                background: #f1f3f5;
                font-weight: 600;
            }
            #bcp-shortcuts-close {
                border: 1px solid #c8d0d7;
                background: #fff;
                color: #4f5b66;
                padding: 4px 10px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 16px;
            }
            #bcp-shortcuts-close:hover {
                border-color: #1da0c3;
                color: #1da0c3;
                background: #eef9fc;
            }
            #bcp-shortcuts-body {
                padding: 12px 14px 14px;
            }
            .bcp-shortcut-row {
                display: grid;
                grid-template-columns: 180px 1fr;
                gap: 12px;
                padding: 8px 0;
                border-bottom: 1px solid #e5eaee;
                font-size: 14px;
            }
            .bcp-shortcut-row:last-child {
                border-bottom: 0;
            }
            .bcp-k {
                display: inline-block;
                font-family: "SFMono-Regular", Consolas, Menlo, monospace;
                background: #fff;
                border: 1px solid #cfd6dc;
                border-radius: 4px;
                padding: 2px 8px;
                color: #1d2b36;
                white-space: nowrap;
            }
        `;
        document.head.appendChild(style);
        document.body.appendChild(shortcutsOverlay);

        shortcutsOverlay.querySelector('#bcp-shortcuts-backdrop').addEventListener('click', hideShortcutsOverlay);
        shortcutsOverlay.querySelector('#bcp-shortcuts-close').addEventListener('click', hideShortcutsOverlay);
    }

    function showShortcutsOverlay() {
        ensureShortcutsOverlay();
        shortcutsOverlay.classList.add('open');
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
    }

    function hideShortcutsOverlay() {
        if (!shortcutsOverlay) return;
        shortcutsOverlay.classList.remove('open');
        document.documentElement.style.overflow = '';
        document.body.style.overflow = '';
    }

    function isShortcutsOverlayOpen() {
        return !!shortcutsOverlay && shortcutsOverlay.classList.contains('open');
    }

    function getWishlistStateElements() {
        return {
            add:
                document.querySelector('#wishlist-msg') ||
                document.querySelector('.wishlist-msg'),
            inWishlist:
                document.querySelector('#wishlisted-msg') ||
                document.querySelector('.wishlisted-msg'),
            purchased:
                document.querySelector('#purchased-msg') ||
                document.querySelector('.purchased-msg')
        };
    }

    function clickElement(el) {
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true
        }));
        return true;
    }

    function addCurrentTrackToWishlist() {
        const { add, inWishlist, purchased } = getWishlistStateElements();

        function getClickableWishlistTarget(el) {
            if (!el) return null;
            return el.querySelector('.trigger') ||
                   el.querySelector('a') ||
                   el;
        }

        if (isElementVisible(add)) {
            const target = getClickableWishlistTarget(add);
            clickElement(target);
            showPopup('Added to wishlist');
            return;
        }

        if (isElementVisible(inWishlist)) {
            showPopup('Already in wishlist');
            return;
        }

        if (isElementVisible(purchased)) {
            showPopup('You already own this item');
            return;
        }

        const fallback =
            document.querySelector('.wishlist-msg .trigger') ||
            document.querySelector('.wishlist-msg a') ||
            document.querySelector('.wishlist-msg') ||
            document.querySelector('#collect-item .action[title*="wishlist" i]') ||
            document.querySelector('#collect-item .collect-msg a') ||
            document.querySelector('.wishlist-button') ||
            document.querySelector('.collect-item-button');

        if (fallback && isElementVisible(fallback.closest('.wishlist-msg') || fallback)) {
            clickElement(fallback);
            showPopup('Wishlist action triggered');
            return;
        }

        showPopup('Wishlist button not found');
    }

    function removeCurrentTrackFromWishlist() {
        const { inWishlist } = getWishlistStateElements();

        if (!isElementVisible(inWishlist)) {
            showPopup('Not in wishlist');
            return;
        }

        // Try to find direct unwishlist / remove elements
        const removeSelectors = [
            '.unwishlist-anchor',
            '.unwish',
            '.remove-unwishlist',
            '#collect-item .uncollect-msg a',
            '.wishlist-msg .unwish',
            'a[title*="remove from wishlist" i]',
            'button[title*="remove from wishlist" i]',
            '.wishlisted-msg .trigger',
            '.wishlisted-msg a'
        ];

        for (const sel of removeSelectors) {
            const el = document.querySelector(sel);
            if (el && isElementVisible(el)) {
                clickElement(el);
                showPopup('Removed from wishlist');
                return;
            }
        }

        // If not found directly, let's look for any link/button with "remove" inside the wishlisted message
        if (inWishlist) {
            const links = Array.from(inWishlist.querySelectorAll('a, span, button'));
            for (const link of links) {
                const txt = (link.textContent || '').trim().toLowerCase();
                if (txt.includes('remove') || txt.includes('unwish') || txt.includes('delete')) {
                    clickElement(link);
                    showPopup('Removed from wishlist');
                    return;
                }
            }

            // Fallback: click the trigger in the wishlisted message to toggle or open edit
            const trigger = inWishlist.querySelector('.trigger') || inWishlist.querySelector('a') || inWishlist;
            if (trigger) {
                clickElement(trigger);
                // On some layouts, clicking this toggles it off, or opens the edit popup.
                // If it opens the edit popup, let's look for a remove link inside the newly visible popup after a brief delay
                setTimeout(() => {
                    const popupRemove =
                        document.querySelector('.unwishlist-anchor') ||
                        document.querySelector('a[href*="unwishlist"]') ||
                        Array.from(document.querySelectorAll('a, span, button')).find(el => {
                            const txt = (el.textContent || '').trim().toLowerCase();
                            return isElementVisible(el) && (txt.includes('remove from wishlist') || txt === 'remove' || txt.includes('unwish'));
                        });
                    if (popupRemove) {
                        clickElement(popupRemove);
                        showPopup('Removed from wishlist');
                    }
                }, 150);
                showPopup('Wishlist action triggered');
                return;
            }
        }

        showPopup('Remove button not found');
    }

    function getCollectionActiveItem() {
        const selectors = [
            '.collection-item-container.playing',
            '.collection-item-container.current',
            '.collection-item.playing',
            '.collection-item.current',
            '.track_play_auxiliary.playing',
            '.track_play_auxiliary.current',
            '.item-playing',
            '.is-playing',
            '.playing',
            '.current_track'
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) {
                return el.closest('.collection-item-container, .collection-item, li, tr, div');
            }
        }

        const activePressed = document.querySelector('.track_play_auxiliary[aria-pressed="true"], .track_play_auxiliary.active');
        if (activePressed) {
            return activePressed.closest('.collection-item-container, .collection-item, li, tr, div');
        }

        return null;
    }

    function getCollectionItemTitleFromEl(el) {
        if (!el) return '';

        const selectors = [
            '.collection-item-title',
            '.item-title',
            '.trackTitle',
            '.title',
            '.heading',
            '.fav-track-title',
            'h4',
            'h3',
            'a[href*="/track/"]',
            'a[href*="/album/"]'
        ];

        for (const selector of selectors) {
            const node = el.querySelector(selector);
            if (node) {
                const text = stripTrailingDuration(node.textContent);
                if (text) return text;
            }
        }

        return '';
    }

    function getCollectionItemArtistFromEl(el) {
        if (!el) return '';

        const selectors = [
            '.collection-item-artist',
            '.artist',
            '.itemsubtext',
            '.subhead',
            '.byline',
            'a[href*=".bandcamp.com"]'
        ];

        for (const selector of selectors) {
            const node = el.querySelector(selector);
            if (node) {
                const text = cleanText(node.textContent);
                if (text && text.toLowerCase() !== 'track' && text.toLowerCase() !== 'favorite track') {
                    return text.replace(/^by\s+/i, '');
                }
            }
        }

        return '';
    }

    function getCollectionItemLinkFromEl(el) {
        if (!el) return null;
        const link = el.querySelector('a[href*="/track/"], a[href*="/album/"]');
        return link?.href || null;
    }

    function getAlbumInfo() {
        let artist = '';
        let album = '';

        if (window.TralbumData) {
            artist = window.TralbumData.artist || '';
            album = window.TralbumData.current?.title || '';
        }

        if (isCollectionPage()) {
            const activeItem = getCollectionActiveItem();
            const activeArtist = getCollectionItemArtistFromEl(activeItem);
            const activeTitle = getCollectionItemTitleFromEl(activeItem);
            if (!artist && activeArtist) artist = activeArtist;
            if (!album && activeTitle) album = activeTitle;
        }

        if (!artist) {
            const el = document.querySelector('#band-name-location .title, .albumTitle ~ .artist, span[itemprop="byArtist"] span, #name-section p span');
            if (el) artist = el.textContent.trim();
        }
        if (!artist) {
            const el = document.querySelector('p.artist-name, .artist span, .band-name');
            if (el) artist = el.textContent.trim();
        }
        if (!album) {
            const el = document.querySelector('h2.trackTitle, .albumTitle, [itemprop="name"]');
            if (el) album = el.textContent.trim();
        }

        return { artist, album };
    }

    function getHeaderArtistName() {
        if (isCollectionPage()) {
            const activeItem = getCollectionActiveItem();
            const artist = getCollectionItemArtistFromEl(activeItem);
            if (artist) return artist;
        }

        const artistLink =
            document.querySelector('#name-section h3 a') ||
            document.querySelector('#band-name-location a') ||
            document.querySelector('#name-section h3 span a') ||
            document.querySelector('span[itemprop="byArtist"] a') ||
            document.querySelector('span[itemprop="byArtist"] span');

        if (artistLink) return cleanText(artistLink.textContent);

        const info = getAlbumInfo();
        return cleanText(info.artist) || 'Unknown Artist';
    }

    function looksLikeNonArtistLabel(text) {
        const t = cleanText(text).toLowerCase();
        const badWords = [
            'remix', 'mix', 'edit', 'version', 'live', 'instrumental',
            'demo', 'vip', 'rework', 'dub', 'remaster', 'original mix',
            'extended mix', 'radio edit', 'acoustic', 'intro', 'outro'
        ];
        return badWords.some(word =>
            t === word ||
            t.endsWith(' ' + word) ||
            t.includes('(' + word) ||
            t.includes('[' + word)
        );
    }

    function splitOnDash(title) {
        return cleanText(title).split(/\s[-–—]\s/).map(cleanText).filter(Boolean);
    }

    function parseTitleAndArtist(rawTitle, fallbackArtist) {
        const title = cleanText(rawTitle);
        const headerArtist = cleanText(fallbackArtist);
        const headerLower = headerArtist.toLowerCase();
        const dashParts = splitOnDash(title);

        if (dashParts.length === 2) {
            const [left, right] = dashParts;
            const leftLower = left.toLowerCase();
            const rightLower = right.toLowerCase();

            if (leftLower === headerLower && !looksLikeNonArtistLabel(left)) {
                return { title: right, artist: headerArtist };
            }

            if (rightLower === headerLower && !looksLikeNonArtistLabel(right)) {
                return { title: left, artist: headerArtist };
            }

            if (looksLikeNonArtistLabel(left) || looksLikeNonArtistLabel(right)) {
                return { title, artist: headerArtist };
            }

            if (left.length <= 40 && right.length > left.length) {
                return { title: right, artist: left };
            }

            if (right.length <= 40 && left.length > right.length) {
                return { title: left, artist: right };
            }
        }

        return { title, artist: headerArtist };
    }

    function getCollectionTracks() {
        const cards = Array.from(document.querySelectorAll('.collection-item-container, .collection-item'));
        const tracks = cards.map(card => getCollectionItemTitleFromEl(card)).filter(Boolean);

        if (tracks.length) return tracks;

        const aux = Array.from(document.querySelectorAll('a.track_play_auxiliary')).map(el => {
            const wrap = el.closest('.collection-item-container, .collection-item, li, div');
            return getCollectionItemTitleFromEl(wrap);
        }).filter(Boolean);

        return aux;
    }

    function getAllTracks() {
        if (window.TralbumData?.trackinfo?.length) {
            return window.TralbumData.trackinfo.map(t => stripTrailingDuration(t.title || ''));
        }

        if (isCollectionPage()) {
            const tracks = getCollectionTracks();
            if (tracks.length) return tracks;
        }

        const rows = document.querySelectorAll('.track_row_view');
        if (rows.length) {
            return Array.from(rows).map(r => {
                const t = r.querySelector('.track-title, .title');
                return t ? stripTrailingDuration(t.textContent) : '';
            });
        }

        const h2 = document.querySelector('#name-section h2.trackTitle, h2.trackTitle');
        return h2 ? [stripTrailingDuration(h2.textContent)] : [];
    }

    function getCurrentIndex() {
        const audio = getAudio();

        if (audio?.src && window.TralbumData?.trackinfo?.length) {
            const src = audio.src;
            const idx = window.TralbumData.trackinfo.findIndex(t =>
                t.file && Object.values(t.file).some(url => {
                    const key = url.split('?')[0].split('/').pop().split('.')[0];
                    return key && src.includes(key);
                })
            );
            if (idx !== -1) return idx;
        }

        if (isCollectionPage()) {
            const active = getCollectionActiveItem();
            if (active) {
                const items = Array.from(document.querySelectorAll('.collection-item-container, .collection-item'));
                const idx = items.indexOf(active);
                if (idx !== -1) return idx;
            }
        }

        const rows = document.querySelectorAll('.track_row_view');
        let found = -1;
        rows.forEach((r, i) => {
            if (r.classList.contains('current_track') || r.classList.contains('playing')) found = i;
        });

        if (found !== -1) return found;
        if (isTrackPage()) return 0;
        return found;
    }

    function getCurrentTrackRawTitle() {
        const cur = getCurrentIndex();

        if (isCollectionPage()) {
            const active = getCollectionActiveItem();
            const title = getCollectionItemTitleFromEl(active);
            if (title) return title;
        }

        if (cur >= 0) {
            const rows = document.querySelectorAll('.track_row_view');
            if (rows[cur]) {
                const row = rows[cur];
                const preferredTitleEl =
                    row.querySelector('.title-col .linked-title') ||
                    row.querySelector('.title-col a span') ||
                    row.querySelector('.track-title a') ||
                    row.querySelector('.track-title') ||
                    row.querySelector('.title');

                if (preferredTitleEl) {
                    return stripTrailingDuration(preferredTitleEl.textContent);
                }
            }
        }

        if (window.TralbumData?.trackinfo?.length && cur >= 0 && window.TralbumData.trackinfo[cur]) {
            return stripTrailingDuration(window.TralbumData.trackinfo[cur].title || '');
        }

        const titleEl = document.querySelector('#name-section h2.trackTitle, h2.trackTitle');
        return titleEl ? stripTrailingDuration(titleEl.textContent) : '';
    }

    async function copyCurrentTrackInfo() {
        const rawTitle = getCurrentTrackRawTitle();
        const headerArtist = getHeaderArtistName();

        if (!rawTitle) {
            showPopup('Could not determine current track');
            return;
        }

        const parsed = parseTitleAndArtist(rawTitle, headerArtist);
        const bpmPart = currentTappedBpm ? ` - BPM ${currentTappedBpm}` : '';
        const text = `${parsed.title} - ${parsed.artist}${bpmPart}`;
        const ok = await copyToClipboard(text);
        showPopup(ok ? `Copied: ${text}` : `Copy failed: ${text}`);
    }

    function getCurrentTrackUrl() {
        if (isCollectionPage()) {
            const active = getCollectionActiveItem();
            const url = getCollectionItemLinkFromEl(active);
            if (url) return url;
        }

        const cur = getCurrentIndex();
        const rows = document.querySelectorAll('.track_row_view');

        if (cur >= 0 && rows[cur]) {
            const link = rows[cur].querySelector('.title-col a, .track-title a, a.linked-title');
            if (link && link.href) return link.href;
        }

        if (isTrackPage()) {
            return window.location.href;
        }

        if (window.TralbumData?.url && window.location.origin) {
            return new URL(window.TralbumData.url, window.location.origin).href;
        }

        return null;
    }

    function setBpmDisplay(text) {
        const el = document.getElementById('bcp-bpm');
        if (el) el.textContent = text;
    }

    function scheduleBpmTapReset() {
        if (bpmTapResetTimer) clearTimeout(bpmTapResetTimer);
        bpmTapResetTimer = setTimeout(() => {
            bpmTapTimes = [];
            currentTappedBpm = null;
            setBpmDisplay('BPM TAP');
        }, TAP_RESET_MS);
    }

    function tapBpm() {
        const now = performance.now();

        if (bpmTapTimes.length && now - bpmTapTimes[bpmTapTimes.length - 1] > TAP_RESET_MS) {
            bpmTapTimes = [];
            currentTappedBpm = null;
        }

        bpmTapTimes.push(now);

        if (bpmTapTimes.length > TAP_MAX_SAMPLES) {
            bpmTapTimes.shift();
        }

        scheduleBpmTapReset();

        if (bpmTapTimes.length < 2) {
            setBpmDisplay('TAP...');
            return;
        }

        const intervals = [];
        for (let i = 1; i < bpmTapTimes.length; i++) {
            intervals.push(bpmTapTimes[i] - bpmTapTimes[i - 1]);
        }

        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        if (!avgInterval || !isFinite(avgInterval)) {
            setBpmDisplay('TAP...');
            return;
        }

        let bpm = 60000 / avgInterval;

        while (bpm < 70) bpm *= 2;
        while (bpm > 180) bpm /= 2;

        currentTappedBpm = Math.round(bpm);
        setBpmDisplay(`BPM ${currentTappedBpm}`);
    }

    function openCurrentTrackPage() {
        const url = getCurrentTrackUrl();
        if (!url) {
            showPopup('Could not determine current track link');
            return;
        }
        window.location.href = url;
    }

    function saveVol(v, muted) {
        try {
            localStorage.setItem(VOL_KEY, v);
            localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
            sessionStorage.setItem(VOL_KEY, v);
            sessionStorage.setItem(MUTE_KEY, muted ? '1' : '0');
        } catch (e) {}
    }

    function loadVol() {
        try {
            const v = parseFloat(sessionStorage.getItem(VOL_KEY) ?? localStorage.getItem(VOL_KEY));
            return isNaN(v) ? 1 : Math.max(0, Math.min(1, v));
        } catch (e) {
            return 1;
        }
    }

    function loadMuted() {
        try {
            const s = sessionStorage.getItem(MUTE_KEY) ?? localStorage.getItem(MUTE_KEY);
            return s === '1';
        } catch (e) {
            return false;
        }
    }

    function saveSpeed(v) {
        try {
            localStorage.setItem(SPEED_KEY, String(v));
            sessionStorage.setItem(SPEED_KEY, String(v));
        } catch (e) {}
    }

    function loadSpeed() {
        try {
            const v = parseFloat(sessionStorage.getItem(SPEED_KEY) ?? localStorage.getItem(SPEED_KEY));
            if (isNaN(v)) return SPEED_DEFAULT;
            return Math.max(SPEED_MIN, Math.min(SPEED_MAX, v));
        } catch (e) {
            return SPEED_DEFAULT;
        }
    }

    function savePreservePitch(v) {
        try {
            localStorage.setItem(PRESERVE_PITCH_KEY, v ? '1' : '0');
            sessionStorage.setItem(PRESERVE_PITCH_KEY, v ? '1' : '0');
        } catch (e) {}
    }

    function loadPreservePitch() {
        try {
            const s = sessionStorage.getItem(PRESERVE_PITCH_KEY) ?? localStorage.getItem(PRESERVE_PITCH_KEY);
            return s == null ? true : s === '1';
        } catch (e) {
            return true;
        }
    }

    function setAudioPreservePitch(audio, enabled) {
        if (!audio) return false;
        let supported = false;

        if ('preservesPitch' in audio) {
            audio.preservesPitch = enabled;
            supported = true;
        }
        if ('mozPreservesPitch' in audio) {
            audio.mozPreservesPitch = enabled;
            supported = true;
        }
        if ('webkitPreservesPitch' in audio) {
            audio.webkitPreservesPitch = enabled;
            supported = true;
        }

        return supported;
    }

    function updateSpeedUi(speed) {
        const slider = document.getElementById('bcp-speed');
        const label = document.getElementById('bcp-speed-label');

        if (slider) slider.value = String(speed);
        if (label) {
            label.textContent = fmtSpeed(speed);
            label.classList.toggle('non-default', Math.abs(speed - 1.0) > 0.001);
        }
    }

    function updatePreservePitchUi() {
        const btn = document.getElementById('bcp-preserve-pitch');
        if (!btn) return;

        const enabled = loadPreservePitch();
        const audio = getAudio();
        const supported = !!audio && (
            'preservesPitch' in audio ||
            'mozPreservesPitch' in audio ||
            'webkitPreservesPitch' in audio
        );

        btn.textContent = supported ? (enabled ? 'PP ON' : 'PP OFF') : 'PP N/A';
        btn.disabled = !supported;
        btn.style.opacity = supported ? '1' : '0.45';
    }

    function applySpeed(v) {
        const speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Number(v)));
        const audio = getAudio();
        if (audio) {
            audio.playbackRate = speed;
            setAudioPreservePitch(audio, loadPreservePitch());
        }

        updateSpeedUi(speed);
        saveSpeed(speed);
    }

    function togglePreservePitch() {
        const audio = getAudio();
        const supported = !!audio && (
            'preservesPitch' in audio ||
            'mozPreservesPitch' in audio ||
            'webkitPreservesPitch' in audio
        );

        if (!supported) {
            showPopup('Preserve pitch is not supported in this browser');
            updatePreservePitchUi();
            return;
        }

        const next = !loadPreservePitch();
        savePreservePitch(next);
        setAudioPreservePitch(audio, next);
        updatePreservePitchUi();
        showPopup(next ? 'Preserve pitch enabled' : 'Preserve pitch disabled');
    }

    function jumpToTrack(index) {
        const tracks = getAllTracks().filter(Boolean);
        if (tracks.length <= 1) return;

        if (isCollectionPage()) {
            const items = Array.from(document.querySelectorAll('.collection-item-container, .collection-item'));
            const target = items[index];
            if (target) {
                const playEl =
                    target.querySelector('.track_play_auxiliary') ||
                    target.querySelector('.item_link_play') ||
                    target.querySelector('.collection-item-art') ||
                    target.querySelector('a[data-trackid]');
                if (playEl) {
                    playEl.click();
                    return;
                }
            }
        }

        const rows = document.querySelectorAll('.track_row_view');
        if (rows[index]) {
            const btn = rows[index].querySelector('.play_status, .play_col, .track_play_hilite, a.play_row_for');
            if (btn) {
                btn.click();
                return;
            }
            const link = rows[index].querySelector('.title-col a, .track-title a');
            if (link) {
                link.click();
                return;
            }
            rows[index].click();
            return;
        }

        const cur = getCurrentIndex();
        if (cur === -1) return;
        const diff = index - cur;
        if (diff === 0) return;

        const btn = diff > 0 ? getNativeBtn('.nextbutton') : getNativeBtn('.prevbutton');
        let steps = Math.abs(diff);

        (function step() {
            if (steps-- <= 0) return;
            if (btn) btn.click();
            if (steps > 0) setTimeout(step, 80);
        })();
    }

    function preloadFirstTrack() {
        if (preloadDone) return;

        if (!window.TralbumData?.trackinfo?.length && !isTrackPage() && !isCollectionPage()) return;

        const savedVol = loadVol();
        const firstRow = document.querySelector('.track_row_view');

        let trigger =
            firstRow?.querySelector('.play_status') ||
            firstRow?.querySelector('.play_col') ||
            firstRow?.querySelector('.track_play_hilite') ||
            firstRow?.querySelector('a.play_row_for') ||
            firstRow?.querySelector('.title-col .linked-title a') ||
            firstRow?.querySelector('.title-col a');

        if (!trigger && isCollectionPage()) {
            const firstCollectionItem = document.querySelector('.track_play_auxiliary, .item_link_play, a[data-trackid]');
            if (firstCollectionItem) trigger = firstCollectionItem;
        }

        if (!trigger && !isTrackPage()) return;

        preloadDone = true;

        function muteAndClick() {
            const a = getAudio();
            if (a) {
                a.volume = 0;
                a.muted = true;
            }

            if (trigger) {
                trigger.click();
            } else if (isTrackPage()) {
                const playBtn = getNativeBtn('.playbutton');
                if (playBtn) playBtn.click();
            }

            waitForBuffer(80);
        }

        function waitForBuffer(attempts) {
            if (attempts <= 0) {
                const a = getAudio();
                if (a) {
                    a.pause();
                    a.muted = false;
                    a.volume = loadMuted() ? 0 : savedVol;
                    a.currentTime = 0;
                    a.playbackRate = loadSpeed();
                    setAudioPreservePitch(a, loadPreservePitch());
                }
                preloadReady = true;
                syncVolSlider(savedVol);
                return;
            }

            const a = getAudio();
            if (!a) {
                setTimeout(() => waitForBuffer(attempts - 1), 50);
                return;
            }

            a.volume = 0;
            a.muted = true;

            if (a.readyState >= 2 || (isFinite(a.duration) && a.duration > 0)) {
                a.pause();
                a.currentTime = 0;
                a.muted = false;
                a.volume = loadMuted() ? 0 : savedVol;
                a.playbackRate = loadSpeed();
                setAudioPreservePitch(a, loadPreservePitch());
                a._bcpInited = true;
                preloadReady = true;
                syncVolSlider(savedVol);
                return;
            }

            setTimeout(() => waitForBuffer(attempts - 1), 50);
        }

        function syncVolSlider(v) {
            const volEl = document.getElementById('bcp-vol');
            if (volEl) volEl.value = String(v);
        }

        setTimeout(muteAndClick, 400);
    }

    function getTags() {
        return Array.from(document.querySelectorAll('a.tag, .tags a, [class*="tag"] a'))
            .map(a => a.textContent.trim())
            .filter(t => t.length > 0 && t.length < 40);
    }

    function hidePageElements() {
        if (isCollectionPage()) return;

        const existing = document.getElementById('bcp-hide-native');
        if (existing) return;

        const s = document.createElement('style');
        s.id = 'bcp-hide-native';
        s.textContent = `
            .inline_player, #player, .html5-player,
            div[id="player"], div.player-section { display: none !important; }
            .tralbumData.tralbum-tags, .tags,
            .tag-list, div.tralbum-tags,
            p.tags-inner { display: none !important; }
        `;
        document.head.appendChild(s);
    }

    const SVG_VOL = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><polygon points="1,4 5,4 9,1 9,13 5,10 1,10" fill="currentColor"/><path d="M10.5 4.5 Q12.5 7 10.5 9.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/><path d="M11.8 2.8 Q14.5 7 11.8 11.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>`;
    const SVG_MUTE = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><polygon points="1,4 5,4 9,1 9,13 5,10 1,10" fill="currentColor"/><path d="M10.5 4.5 Q12.5 7 10.5 9.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/><path d="M11.8 2.8 Q14.5 7 11.8 11.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/><line x1="1" y1="13" x2="13" y2="1" stroke="#e05" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    const SVG_PLAY = `<svg width="12" height="13" viewBox="0 0 12 13" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><polygon points="0,0 12,6.5 0,13"/></svg>`;
    const SVG_PAUSE = `<svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="4" height="13"/><rect x="7" y="0" width="4" height="13"/></svg>`;

    function buildPlayer() {
        if (document.getElementById('bc-sticky-player')) return null;

        hidePageElements();

        const savedVol = loadVol();
        const savedMuted = loadMuted();
        const savedSpeed = loadSpeed();

        const bar = document.createElement('div');
        bar.id = 'bc-sticky-player';
        bar.innerHTML = `
<style>
#bc-sticky-player {
    position: fixed; bottom: 0; left: 0; right: 0;
    z-index: 999999;
    font-family: Helvetica, Arial, sans-serif;
    background: #f3f3f3;
    border-top: 1px solid #cfd6dc;
    color: #222;
    display: flex; flex-direction: column;
    box-shadow: 0 -2px 14px rgba(0,0,0,0.08);
    user-select: none;
}
#bc-sticky-player * { box-sizing: border-box; }

#bcp-row1 {
    display: flex; align-items: center; gap: 10px;
    padding: 0 12px; min-height: 58px;
    background: #f7f7f7;
}

#bcp-row2 {
    height: 22px;
    display: flex; align-items: center;
    padding: 0 10px 2px;
    border-top: 1px solid #dde3e8;
    overflow: hidden;
    gap: 0;
    background: #efefef;
}

#bcp-album-info {
    font-size: 10px;
    color: #666;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 1;
    min-width: 0;
    max-width: 36%;
    letter-spacing: 0.02em;
}
#bcp-album-info .bcp-artist { color: #444; }
#bcp-album-info .bcp-sep    { color: #9aa4ad; margin: 0 4px; }
#bcp-album-info .bcp-album  { color: #6d7780; }

#bcp-row2-spacer { flex: 1; }

#bcp-tags-label, #bcp-help-link {
    font-size: 8px;
    color: #9aa4ad;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    flex-shrink: 0;
}
#bcp-tags-label { margin-right: 5px; }
#bcp-help-link {
    margin-left: 10px;
    cursor: pointer;
}
#bcp-help-link:hover {
    color: #1da0c3;
}

#bcp-tags-list {
    display: flex; gap: 5px;
    overflow: hidden; flex-wrap: nowrap;
    flex-direction: row-reverse;
}

.bcp-tag {
    font-size: 11px;
    color: #4b5660;
    background: transparent;
    border: none;
    padding: 0 2px;
    white-space: nowrap;
    letter-spacing: 0.03em;
    font-family: inherit;
}
.bcp-tag::before { content: '#'; color: #8d98a2; }

.bcp-btn {
    background: #fafafa;
    border: 1px solid #c8d0d7;
    color: #5b6670;
    border-radius: 3px;
    width: 34px; height: 28px;
    display: inline-flex; align-items: center; justify-content: center;
    font-family: inherit; font-size: 13px; cursor: pointer;
    transition: border-color .12s, color .12s, background .12s, box-shadow .12s, opacity .12s;
    flex-shrink: 0; padding: 0;
}
.bcp-btn:hover:not(:disabled) {
    border-color: #1da0c3;
    color: #1da0c3;
    background: #ffffff;
    box-shadow: 0 0 0 1px rgba(29,160,195,0.08);
}
.bcp-btn:disabled {
    pointer-events: none;
}

#bcp-play {
    border-color: #1da0c3;
    color: #1da0c3;
    width: 36px;
    background: #ffffff;
}
#bcp-play:hover:not(:disabled) {
    background: #eef9fc;
}

#bcp-meta-title {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    flex: 1;
    overflow: hidden;
}

#bcp-meta {
    font-size: 11px;
    color: #1da0c3;
    white-space: nowrap;
    flex-shrink: 0;
    letter-spacing: 0.03em;
}
#bcp-title {
    font-size: 13px;
    font-weight: bold;
    color: #222;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
}

#bcp-time {
    font-size: 12px;
    color: #5f6973;
    flex-shrink: 0;
    min-width: 90px;
    text-align: center;
    letter-spacing: 0.04em;
}

#bcp-bpm {
    font-size: 11px;
    color: #5f6973;
    flex-shrink: 0;
    min-width: 68px;
    text-align: center;
    letter-spacing: 0.03em;
    cursor: pointer;
    border-radius: 3px;
    padding: 3px 4px;
}
#bcp-bpm:hover {
    background: rgba(29,160,195,0.08);
    color: #1da0c3;
}

.bcp-seek {
    flex: 0 1 170px;
    min-width: 90px;
    display: flex;
    align-items: center;
}

.bcp-range {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: #cfd6dc;
    outline: none;
    cursor: pointer;
    accent-color: #1da0c3;
}
.bcp-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #1da0c3;
    cursor: pointer;
    border: none;
}

#bcp-speed-inline {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    flex: 0 0 120px;
    min-width: 120px;
}

#bcp-speed-topline {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 9px;
    color: #6f7a84;
    letter-spacing: 0.04em;
}
#bcp-speed-label {
    color: #1d2b36;
    font-size: 10px;
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 3px;
}
#bcp-speed-label:hover {
    background: rgba(29,160,195,0.08);
    color: #1da0c3;
}
#bcp-speed-label.non-default {
    color: #1da0c3;
    font-weight: 700;
}

#bcp-preserve-pitch {
    border: 1px solid #c8d0d7;
    background: #fff;
    color: #4f5b66;
    border-radius: 3px;
    font-size: 9px;
    padding: 1px 4px;
    cursor: pointer;
    line-height: 1.4;
}
#bcp-preserve-pitch:hover:not(:disabled) {
    border-color: #1da0c3;
    color: #1da0c3;
    background: #eef9fc;
}

#bcp-speed-slider-wrap {
    position: relative;
    width: 100%;
    height: 14px;
    display: flex;
    align-items: center;
}

#bcp-speed-marker {
    position: absolute;
    left: 50%;
    transform: translateX(-1px);
    top: 1px;
    width: 2px;
    height: 12px;
    background: #9aa4ad;
    border-radius: 1px;
    pointer-events: none;
    opacity: 0.85;
}

#bcp-speed {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: #cfd6dc;
    outline: none;
    cursor: pointer;
    accent-color: #1da0c3;
    position: relative;
    z-index: 1;
}
#bcp-speed::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #1da0c3;
    cursor: pointer;
    border: none;
}

.bcp-vol-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
}

#bcp-vol-icon {
    color: #6f7a84;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    padding: 2px;
    border-radius: 2px;
    transition: color .12s;
    line-height: 0;
}
#bcp-vol-icon:hover { color: #1da0c3; }
#bcp-vol-icon.muted { color: #a7b0b8; }

.bcp-vol {
    -webkit-appearance: none;
    appearance: none;
    width: 70px;
    height: 4px;
    border-radius: 2px;
    background: #cfd6dc;
    outline: none;
    cursor: pointer;
    accent-color: #1da0c3;
}
.bcp-vol::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #1da0c3;
    cursor: pointer;
    border: none;
}

#bcp-dropdown {
    position: fixed;
    bottom: calc(var(--bcp-bar-height, 88px) + 2px);
    left: 0;
    right: 0;
    z-index: 999998;
    background: #f5f5f5;
    border-top: 1px solid #cfd6dc;
    box-shadow: 0 -6px 24px rgba(0,0,0,0.10);
    max-height: 320px;
    overflow-y: auto;
    display: none;
    font-family: Helvetica, Arial, sans-serif;
}
#bcp-dropdown.open { display: block; }
#bcp-dropdown::-webkit-scrollbar { width: 6px; }
#bcp-dropdown::-webkit-scrollbar-track { background: #e8edf1; }
#bcp-dropdown::-webkit-scrollbar-thumb { background: #bcc6ce; border-radius: 3px; }

.bcp-track-item {
    padding: 8px 16px;
    font-size: 12px;
    color: #4b5660;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid #e1e6ea;
    transition: background .1s, color .1s;
}
.bcp-track-item:hover {
    background: #eef9fc;
    color: #222;
}
.bcp-track-item.active {
    color: #1da0c3;
    font-weight: bold;
    background: #e9f7fb;
}
.bcp-track-num {
    min-width: 28px;
    color: #8b96a0;
    font-size: 11px;
    text-align: right;
    flex-shrink: 0;
}
.bcp-track-item.active .bcp-track-num { color: #1da0c3; }
</style>

<div id="bcp-row1">
    <button class="bcp-btn" id="bcp-prev" title="Prev (↑)">&#9664;&#9664;</button>
    <button class="bcp-btn" id="bcp-play" title="Play/Pause (Space)">${SVG_PLAY}</button>
    <button class="bcp-btn" id="bcp-next" title="Next (↓)">&#9654;&#9654;</button>

    <div id="bcp-meta-title">
        <span id="bcp-meta">— / —</span>
        <span id="bcp-title">—</span>
    </div>

    <span id="bcp-time">0:00 / 0:00</span>
    <span id="bcp-bpm" title="Click repeatedly to tap tempo">BPM TAP</span>

    <div class="bcp-seek">
        <input type="range" class="bcp-range" id="bcp-seek" min="0" max="100" value="0" step="0.1">
    </div>

    <div id="bcp-speed-inline">
        <div id="bcp-speed-topline">
            <span>SPEED</span>
            <span id="bcp-speed-label" title="Double-click to reset to 1.00x">${fmtSpeed(savedSpeed)}</span>
            <button id="bcp-preserve-pitch" type="button" title="Toggle preserve pitch">PP</button>
        </div>
        <div id="bcp-speed-slider-wrap">
            <span id="bcp-speed-marker" title="1.00x"></span>
            <input type="range" id="bcp-speed" min="${SPEED_MIN}" max="${SPEED_MAX}" step="${SPEED_STEP}" value="${savedSpeed}">
        </div>
    </div>

    <div class="bcp-vol-wrap">
        <span id="bcp-vol-icon" title="Mute/unmute (click)">${SVG_VOL}</span>
        <input type="range" class="bcp-vol" id="bcp-vol" min="0" max="1" step="0.02" value="${savedVol}">
    </div>
</div>

<div id="bcp-row2">
    <span id="bcp-album-info">
        <span class="bcp-artist"></span><span class="bcp-sep"></span><span class="bcp-album"></span>
    </span>
    <span id="bcp-row2-spacer"></span>
    <span id="bcp-tags-label">tags</span>
    <div id="bcp-tags-list"></div>
    <span id="bcp-help-link" title="Show shortcuts (? / ß)">help</span>
</div>

<div id="bcp-dropdown"></div>`;

        document.body.insertBefore(bar, document.body.firstChild);

        const barHeight = Math.ceil(bar.getBoundingClientRect().height) || 88;
        document.documentElement.style.setProperty('--bcp-bar-height', `${barHeight}px`);
        document.body.style.paddingBottom = `${barHeight}px`;

        document.getElementById('bcp-prev').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!hasMultipleTracks()) return;
            jumpToTrack(Math.max(0, getCurrentIndex() - 1));
        });

        document.getElementById('bcp-play').addEventListener('click', (e) => {
            e.stopPropagation();
            const b = getNativeBtn('.playbutton');
            if (b) {
                b.click();
                return;
            }

            const audio = getAudio();
            if (audio) {
                if (audio.paused) audio.play().catch(() => {});
                else audio.pause();
            }
        });

        document.getElementById('bcp-next').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!hasMultipleTracks()) return;
            jumpToTrack(Math.min(getAllTracks().length - 1, getCurrentIndex() + 1));
        });

        document.getElementById('bcp-help-link').addEventListener('click', (e) => {
            e.stopPropagation();
            showShortcutsOverlay();
        });

        document.getElementById('bcp-bpm').addEventListener('click', (e) => {
            e.stopPropagation();
            tapBpm();
        });

        const seekEl = document.getElementById('bcp-seek');
        let seekDragging = false;

        seekEl.addEventListener('mousedown', () => { seekDragging = true; });
        window.addEventListener('mouseup', () => { seekDragging = false; });

        seekEl.addEventListener('input', () => {
            const a = getAudio();
            if (a && isFinite(a.duration)) {
                a.currentTime = (seekEl.value / 100) * a.duration;
            }
        });

        const volEl = document.getElementById('bcp-vol');
        const volIcon = document.getElementById('bcp-vol-icon');
        const speedEl = document.getElementById('bcp-speed');
        const speedLabel = document.getElementById('bcp-speed-label');
        const preservePitchBtn = document.getElementById('bcp-preserve-pitch');
        let isMuted = savedMuted;

        function updateVolIcon() {
            volIcon.innerHTML = isMuted ? SVG_MUTE : SVG_VOL;
            volIcon.classList.toggle('muted', isMuted);
        }

        function applyVol(newVal, newMuted) {
            if (newVal !== undefined) {
                volEl.value = String(Math.max(0, Math.min(1, newVal)));
            }
            if (newMuted !== undefined) {
                isMuted = newMuted;
            }
            const a = getAudio();
            if (a) a.volume = isMuted ? 0 : parseFloat(volEl.value);
            updateVolIcon();
            saveVol(parseFloat(volEl.value), isMuted);
        }

        volEl.value = String(savedVol);
        updateVolIcon();
        updateSpeedUi(savedSpeed);

        const initAudio = getAudio();
        if (initAudio) {
            initAudio.volume = savedMuted ? 0 : savedVol;
            initAudio.playbackRate = savedSpeed;
            setAudioPreservePitch(initAudio, loadPreservePitch());
        }

        updatePreservePitchUi();

        volEl.addEventListener('input', () => applyVol(parseFloat(volEl.value), false));
        volIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            applyVol(undefined, !isMuted);
        });

        speedEl.addEventListener('input', () => {
            applySpeed(parseFloat(speedEl.value));
        });

        speedLabel.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            applySpeed(1.0);
            showPopup('Speed reset to 1.00x');
        });

        preservePitchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePreservePitch();
        });

        const dropdown = document.getElementById('bcp-dropdown');
        const metaTitleEl = document.getElementById('bcp-meta-title');

        function openDropdown() {
            const tracks = getAllTracks();
            if (!tracks.length) return;

            const cur = getCurrentIndex();

            dropdown.innerHTML = tracks.map((name, i) => `
                <div class="bcp-track-item${i === cur ? ' active' : ''}" data-index="${i}">
                    <span class="bcp-track-num">${i + 1}.</span>
                    <span>${name || '(untitled)'}</span>
                </div>`).join('');

            dropdown.classList.add('open');

            const active = dropdown.querySelector('.active');
            if (active) active.scrollIntoView({ block: 'nearest' });

            dropdown.querySelectorAll('.bcp-track-item').forEach(item =>
                item.addEventListener('click', () => {
                    jumpToTrack(parseInt(item.dataset.index, 10));
                    dropdown.classList.remove('open');
                })
            );
        }

        metaTitleEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dropdown.classList.contains('open')) dropdown.classList.remove('open');
            else openDropdown();
        });

        document.addEventListener('click', (e) => {
            if (!bar.contains(e.target)) dropdown.classList.remove('open');
        });

        return {
            seekEl,
            volEl,
            speedEl,
            isMuted: () => isMuted,
            seekDragging: () => seekDragging,
            applyVol
        };
    }

    function updateRow2() {
        const tags = getTags();
        const tStr = tags.join('|');
        if (tStr !== lastTagStr) {
            lastTagStr = tStr;
            const el = document.getElementById('bcp-tags-list');
            if (el) el.innerHTML = tags.map(t => `<span class="bcp-tag">${t}</span>`).join('');
        }

        const { artist, album } = getAlbumInfo();
        const aStr = artist + '|' + album;
        if (aStr !== lastAlbumStr) {
            lastAlbumStr = aStr;
            const artistEl = document.querySelector('#bcp-album-info .bcp-artist');
            const sepEl = document.querySelector('#bcp-album-info .bcp-sep');
            const albumEl = document.querySelector('#bcp-album-info .bcp-album');
            if (artistEl) artistEl.textContent = artist;
            if (albumEl) albumEl.textContent = album;
            if (sepEl) sepEl.textContent = (artist && album) ? '·' : '';
        }
    }

    function tick() {
        if (!controls) {
            controls = buildPlayer();
            if (!controls) return;
        }

        preloadFirstTrack();

        const audio = getAudio();
        const playBtn = document.getElementById('bcp-play');
        const timeEl = document.getElementById('bcp-time');
        const titleEl = document.getElementById('bcp-title');
        const metaEl = document.getElementById('bcp-meta');
        const { seekEl, volEl, speedEl, isMuted, seekDragging, applyVol } = controls;

        const prevBtn = document.getElementById('bcp-prev');
        const nextBtn = document.getElementById('bcp-next');
        const enabled = hasMultipleTracks();

        [prevBtn, nextBtn].forEach(btn => {
            if (!btn) return;
            btn.disabled = !enabled;
            btn.style.opacity = enabled ? '1' : '0.45';
            btn.style.cursor = enabled ? 'pointer' : 'default';
        });

        if (!audio) {
            if (playBtn) playBtn.innerHTML = SVG_PLAY;
            return;
        }

        if (!audio._bcpInited && preloadReady) {
            audio._bcpInited = true;
            applyVol(loadVol(), loadMuted());
        }

        audio.playbackRate = loadSpeed();
        setAudioPreservePitch(audio, loadPreservePitch());
        updatePreservePitchUi();

        if (playBtn) playBtn.innerHTML = audio.paused ? SVG_PLAY : SVG_PAUSE;
        if (timeEl) timeEl.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;

        if (seekEl && !seekDragging() && isFinite(audio.duration) && audio.duration > 0) {
            seekEl.value = (audio.currentTime / audio.duration) * 100;
        }

        if (volEl && !volEl.matches(':active') && !isMuted()) {
            volEl.value = String(audio.volume);
        }

        if (speedEl && !speedEl.matches(':active')) {
            updateSpeedUi(loadSpeed());
        }

        const tracks = getAllTracks();
        const cur = getCurrentIndex();
        const metaText = `${cur >= 0 ? cur + 1 : '?'} / ${tracks.length || '?'}`;
        const titleText = (cur >= 0 && tracks[cur]) ? tracks[cur] : (getCurrentTrackRawTitle() || '—');

        if (metaEl && metaText !== lastMetaText) {
            lastMetaText = metaText;
            metaEl.textContent = metaText;
        }

        if (titleEl && titleText !== lastTitleText) {
            lastTitleText = titleText;
            titleEl.textContent = titleText;
        }

        updateRow2();
    }

    document.addEventListener('keydown', (e) => {
        const isTyping = isTypingEvent(e);

        // Skip all shortcuts if typing, except for Escape
        if (isTyping && e.key !== 'Escape' && e.keyCode !== 27) {
            return;
        }

        if (isShortcutsOverlayOpen()) {
            if (isCloseOverlayKey(e)) {
                e.preventDefault();
                e.stopPropagation();
                hideShortcutsOverlay();
            }
            return;
        }

        if (e.key === '?' || e.key === 'ß') {
            e.preventDefault();
            e.stopPropagation();
            showShortcutsOverlay();
            return;
        }

        if (e.key === ' ' && e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' });
            return;
        }

        if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            e.stopPropagation();
            if (!controls) return;

            const { volEl, isMuted, applyVol } = controls;
            const cur = parseFloat(volEl.value);
            const next = e.key === 'ArrowUp' ? Math.min(1, cur + VOL_STEP) : Math.max(0, cur - VOL_STEP);
            applyVol(next, isMuted() && next > 0 ? false : isMuted());
            return;
        }

        switch (e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                e.stopPropagation();
                seekRelative(e.shiftKey ? -SEEK_LARGE : -SEEK_SMALL);
                break;

            case 'ArrowRight':
                e.preventDefault();
                e.stopPropagation();
                seekRelative(e.shiftKey ? SEEK_LARGE : SEEK_SMALL);
                break;

            case 'ArrowUp':
                e.preventDefault();
                e.stopPropagation();
                if (!hasMultipleTracks()) break;
                jumpToTrack(Math.max(0, getCurrentIndex() - 1));
                break;

            case 'ArrowDown':
                e.preventDefault();
                e.stopPropagation();
                if (!hasMultipleTracks()) break;
                jumpToTrack(Math.min(getAllTracks().length - 1, getCurrentIndex() + 1));
                break;

            case ' ':
            case 'Spacebar':
                e.preventDefault();
                e.stopPropagation();
                {
                    const b = getNativeBtn('.playbutton');
                    if (b) b.click();
                    else {
                        const audio = getAudio();
                        if (audio) {
                            if (audio.paused) audio.play().catch(() => {});
                            else audio.pause();
                        }
                    }
                }
                break;

            case 'c':
            case 'C':
                e.preventDefault();
                e.stopPropagation();
                copyCurrentTrackInfo();
                break;

            case 'f':
            case 'F':
                e.preventDefault();
                e.stopPropagation();
                openCurrentTrackPage();
                break;

            case 'w':
            case 'W':
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) {
                    removeCurrentTrackFromWishlist();
                } else {
                    addCurrentTrackToWishlist();
                }
                break;
        }
    }, true);

    function init() {
        setInterval(tick, TICK_MS);
        tick();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
