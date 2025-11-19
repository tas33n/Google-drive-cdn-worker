// Google Drive CDN Dashboard Logic

const fileGrid = document.getElementById('fileGrid');
const assetSearchInput = document.getElementById('assetSearchInput');
const assetCount = document.getElementById('assetCount');
const fileModal = document.getElementById('fileModal');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const loadMoreBtn = document.getElementById('fileLoadMore');
const fileLoadingIndicator = document.getElementById('fileLoadingIndicator');
const filterStatus = document.getElementById('filterStatus');
const filterStatusLabel = filterStatus ? filterStatus.querySelector('span') : null;
const filterPills = Array.from(document.querySelectorAll('.filter-pill'));

const statElements = {
    uploads: document.getElementById('statUploads'),
    requests: document.getElementById('statRequests'),
    deletes: document.getElementById('statDeletes'),
    spaceUsed: document.getElementById('statSpaceUsed'),
    spaceTotal: document.getElementById('statSpaceTotal'),
    totalFiles: document.getElementById('statTotalFiles')
};

const storageElements = {
    used: document.getElementById('storageUsedLabel'),
    total: document.getElementById('storageTotalLabel'),
    usageFill: document.getElementById('storageUsageFill'),
    files: document.getElementById('storageFileCount'),
    folders: document.getElementById('storageFolderCount'),
    uptime: document.getElementById('storageUptime')
};

const heroElements = {
    assets: document.getElementById('heroAssetCount'),
    drives: document.getElementById('heroDriveCount'),
    uploads: document.getElementById('heroUploads'),
    requests: document.getElementById('heroRequests'),
    deletes: document.getElementById('heroDeletes')
};

const driveGridExtras = document.getElementById('driveGridExtras');
const driveMetaLabel = document.getElementById('driveMetaLabel');

const footerElements = {
    version: document.getElementById('footerVersion'),
    buildNote: document.getElementById('footerBuildNote')
};

const dashboardConfig = window.__GDRIVE_CDN_CONFIG__ || {};
const repoDetails = dashboardConfig.repo || {};

const fileTypes = {
    images: { icon: 'ri-image-line', class: 'image', displayName: 'Image' },
    documents: { icon: 'ri-file-text-line', class: 'document', displayName: 'Document' },
    code: { icon: 'ri-code-s-slash-line', class: 'code', displayName: 'Code' },
    data: { icon: 'ri-database-2-line', class: 'data', displayName: 'Data' },
    video: { icon: 'ri-movie-line', class: 'video', displayName: 'Video' },
    audio: { icon: 'ri-music-line', class: 'audio', displayName: 'Audio' },
    other: { icon: 'ri-file-line', class: 'document', displayName: 'File' }
};

let cdnFiles = [];
let filteredFiles = [];
let currentFilter = 'all';
let currentSearch = '';
let nextPageToken = null;
let totalRemoteFiles = 0;
let isLoadingFiles = false;
let searchDebounce;
let hasCompletedInitialLoad = false;
let isAwaitingRemoteUpdate = false;
let isFilterFetchPending = false;
let latestCommitSha = '';

const numberFormatter = new Intl.NumberFormat();

document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    isLoadingFiles = true;
    renderFiles();
    setupEventListeners();
    setupThemeToggle();
    setupHeaderScroll();
    loadTheme();
    hydrateFooterMeta();
    if (loadMoreBtn) {
        loadMoreBtn.style.display = 'none';
    }
    fetchSummary();
    fetchFiles({ reset: true, force: true });
}

function setupEventListeners() {
    if (assetSearchInput) {
        assetSearchInput.addEventListener('input', handleAssetSearch);
    }

    filterPills.forEach((pill) => {
        pill.addEventListener('click', () => handleFilterChange(pill));
    });

    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => fetchFiles());
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeFileModal();
        }
    });
}

function handleAssetSearch(event) {
    currentSearch = event.target.value.trim();
    scheduleFilesFetch(true);
}

function handleFilterChange(pill) {
    if (!pill || pill.disabled) return;
    filterPills.forEach((button) => button.classList.remove('active'));
    pill.classList.add('active');
    currentFilter = pill.dataset.type || 'all';
    const label = (pill.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    showFilterLoadingState(label ? `Filtering ${label}...` : 'Filtering assets...');
    scheduleFilesFetch(true);
}

function showFilterLoadingState(message = 'Filtering assets...') {
    if (!filterStatus) return;
    isFilterFetchPending = true;
    filterStatus.hidden = false;
    filterStatus.classList.add('active');
    if (filterStatusLabel) {
        filterStatusLabel.textContent = message;
    }
    filterPills.forEach((pill) => {
        pill.disabled = true;
        pill.classList.add('pending');
    });
}

function hideFilterLoadingState() {
    if (!isFilterFetchPending || !filterStatus) return;
    isFilterFetchPending = false;
    filterStatus.hidden = true;
    filterStatus.classList.remove('active');
    filterPills.forEach((pill) => {
        pill.disabled = false;
        pill.classList.remove('pending');
    });
}

function scheduleFilesFetch(reset = false) {
    if (reset) {
        isAwaitingRemoteUpdate = true;
        filteredFiles = [];
        renderFiles();
        updateFileCount();
    }
    if (searchDebounce) {
        clearTimeout(searchDebounce);
    }
    searchDebounce = setTimeout(() => fetchFiles({ reset }), 350);
}

function applyLocalFilters() {
    filteredFiles = cdnFiles.filter((file) => {
        const matchesType = currentFilter === 'all' || file.type === currentFilter;
        return matchesType;
    });
    renderFiles();
    updateFileCount();
}

async function fetchSummary() {
    try {
        const response = await fetch('/api/dashboard/summary');
        if (!response.ok) {
            throw new Error('Failed to load dashboard summary');
        }
        const payload = await response.json();
        if (payload.status !== 'success') {
            throw new Error(payload.error?.message || 'Failed to load dashboard summary');
        }
        updateSummaryUI(payload.data || {});
    } catch (error) {
        console.error(error);
        showNotification(error.message || 'Unable to load summary', 'error');
    }
}

function updateSummaryUI(data) {
    const stats = data.stats || {};
    setStatValue(statElements.uploads, stats.totalUploads);
    setStatValue(statElements.requests, stats.totalFileRequests);
    setStatValue(statElements.deletes, stats.totalDeletes);
    setStatValue(heroElements.uploads, stats.totalUploads);
    setStatValue(heroElements.requests, stats.totalFileRequests);
    setStatValue(heroElements.deletes, stats.totalDeletes);

    const storage = data.storage || {};
    if (statElements.spaceUsed) {
        statElements.spaceUsed.textContent = storage.usedDisplay || '--';
    }
    if (statElements.spaceTotal) {
        statElements.spaceTotal.textContent = storage.totalDisplay || '--';
    }
    if (storageElements.used) {
        storageElements.used.textContent = storage.usedDisplay ? `${storage.usedDisplay} used` : '--';
    }
    if (storageElements.total) {
        storageElements.total.textContent = storage.totalDisplay ? `${storage.totalDisplay} total` : '--';
    }
    if (storageElements.usageFill) {
        storageElements.usageFill.style.width = `${storage.percentUsed || 0}%`;
    }

    const files = data.files || {};
    const totalFiles = typeof files.totalFiles === 'number' ? files.totalFiles : null;
    setStatValue(statElements.totalFiles, totalFiles);
    setStatValue(heroElements.assets, totalFiles);
    if (storageElements.files) {
        setStatValue(storageElements.files, totalFiles);
    }
    if (storageElements.folders) {
        setStatValue(storageElements.folders, files.folderCount);
    }
    if (storageElements.uptime) {
        storageElements.uptime.textContent = files.complete === false ? 'Syncing…' : '99.9%';
    }
    updateHeroDriveCount();
    renderDriveGrid(storage, files);
}

function setStatValue(element, value) {
    if (!element) return;
    if (typeof value === 'number') {
        element.textContent = numberFormatter.format(value);
    } else {
        element.textContent = '--';
    }
}

function formatRelativeTime(timestamp) {
    try {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) {
            return '—';
        }
        return date.toLocaleString([], { hour: '2-digit', minute: '2-digit' });
    } catch (error) {
        return '—';
    }
}

function renderDriveGrid(storage = {}, files = {}) {
    if (driveMetaLabel) {
        driveMetaLabel.textContent = storage.timestamp
            ? `Last updated ${formatRelativeTime(storage.timestamp)}`
            : 'Initializing';
    }
    if (!driveGridExtras) {
        return;
    }
    const profiles = getDriveProfiles().filter((profile) => profile && profile.primary !== true);
    if (!profiles.length) {
        driveGridExtras.innerHTML = `
            <article class="drive-card drive-card--ghost">
                <header class="drive-card-header">
                    <div>
                        <h4>Additional Drive</h4>
                        <p>Connect another Google Drive whenever you need more space.</p>
                    </div>
                    <span class="drive-badge">Optional</span>
                </header>
                <p class="drive-placeholder-copy">Populate <code>driveProfiles</code> in your worker config to surface extra drives here.</p>
            </article>
        `;
        return;
    }
    driveGridExtras.innerHTML = profiles.map((profile) => createDriveProfileCard(profile)).join('');
}

function createDriveProfileCard(profile = {}) {
    const usage = profile.usage || {};
    const percent = Number.isFinite(Number(usage.percentUsed))
        ? Number(usage.percentUsed)
        : Number(usage.percent) || 0;
    const normalizedPercent = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
    const usedLabel = usage.usedDisplay || usage.used || '-- used';
    const totalLabel = usage.totalDisplay || usage.total || '-- total';
    const fileCount = typeof profile.fileCount === 'number' ? numberFormatter.format(profile.fileCount) : '--';
    const folderCount = typeof profile.folderCount === 'number' ? numberFormatter.format(profile.folderCount) : '--';
    const statusLabel = profile.status || profile.statusLabel || 'Idle';
    return `
        <article class="drive-card">
            <header class="drive-card-header">
                <div>
                    <h4>${escapeHtml(profile.name || 'Drive')}</h4>
                    <p>${escapeHtml(profile.description || 'Secondary storage target')}</p>
                </div>
                <span class="drive-badge">${escapeHtml(profile.badge || 'Standby')}</span>
            </header>
            <div class="drive-usage">
                <div class="usage-bar">
                    <div class="usage-fill" style="width: ${normalizedPercent}%"></div>
                </div>
                <div class="usage-text">
                    <span>${escapeHtml(usedLabel)}</span>
                    <span>${escapeHtml(totalLabel)}</span>
                </div>
            </div>
            <div class="drive-meta">
                <div>
                    <span>Files</span>
                    <strong>${fileCount}</strong>
                </div>
                <div>
                    <span>Folders</span>
                    <strong>${folderCount}</strong>
                </div>
                <div>
                    <span>Status</span>
                    <strong>${escapeHtml(statusLabel)}</strong>
                </div>
            </div>
        </article>
    `;
}

function getDriveProfiles() {
    const profiles = dashboardConfig.driveProfiles;
    if (Array.isArray(profiles)) {
        return profiles;
    }
    return [];
}

function updateHeroDriveCount() {
    if (!heroElements.drives) return;
    const totalDrives = Math.max(1, getDriveProfiles().length || 0);
    heroElements.drives.textContent = numberFormatter.format(totalDrives);
}

async function hydrateFooterMeta() {
    updateFooterVersionLabel();
    if (!repoDetails.owner || !repoDetails.name) {
        return;
    }
    try {
        const response = await fetch(`https://api.github.com/repos/${repoDetails.owner}/${repoDetails.name}/commits?per_page=1`, {
            headers: {
                Accept: 'application/vnd.github+json'
            }
        });
        if (!response.ok) {
            throw new Error('GitHub metadata unavailable');
        }
        const payload = await response.json();
        const commit = Array.isArray(payload) ? payload[0] : payload;
        latestCommitSha = (commit?.sha || '').slice(0, 7);
        updateFooterVersionLabel();
    } catch (error) {
        console.warn('Unable to fetch GitHub metadata:', error);
    }
}

function updateFooterVersionLabel() {
    if (!footerElements.version) return;
    const versionLabel = dashboardConfig.version ? `Version ${dashboardConfig.version}` : 'Version --';
    const commitSuffix = latestCommitSha ? ` | g${latestCommitSha}` : '';
    footerElements.version.textContent = `${versionLabel}${commitSuffix}`;
}

async function fetchFiles({ reset = false, force = false } = {}) {
    if (isLoadingFiles && !force) {
        return;
    }
    if (!reset && !nextPageToken) {
        return;
    }
    isLoadingFiles = true;
    toggleLoadingState(true);

    if (reset) {
        cdnFiles = [];
        filteredFiles = [];
        nextPageToken = null;
        renderFiles();
        updateFileCount();
    }

    const params = new URLSearchParams({ pageSize: '24' });
    if (nextPageToken && !reset) {
        params.set('pageToken', nextPageToken);
    }
    if (currentSearch) {
        params.set('search', currentSearch);
    }
    if (currentFilter !== 'all') {
        params.set('type', currentFilter);
    }

    try {
        const response = await fetch(`/api/dashboard/files?${params.toString()}`);
        if (!response.ok) {
            throw new Error('Unable to load files from the worker');
        }
        const payload = await response.json();
        if (payload.status !== 'success') {
            throw new Error(payload.error?.message || 'Unable to load files from the worker');
        }
        const data = payload.data || {};
        const files = Array.isArray(data.files) ? data.files : [];
        nextPageToken = data.nextPageToken || null;
        if (typeof data.totalFiles === 'number') {
            totalRemoteFiles = data.totalFiles;
        }
        cdnFiles = reset ? files : cdnFiles.concat(files);
        isAwaitingRemoteUpdate = false;
        applyLocalFilters();
        toggleLoadMore(Boolean(nextPageToken));
    } catch (error) {
        console.error(error);
        showNotification(error.message || 'Failed to load assets', 'error');
        toggleLoadMore(false);
    } finally {
        isLoadingFiles = false;
        toggleLoadingState(false);
        hasCompletedInitialLoad = true;
        isAwaitingRemoteUpdate = false;
        hideFilterLoadingState();
    }
}

function toggleLoadingState(state) {
    if (fileLoadingIndicator) {
        fileLoadingIndicator.classList.toggle('active', state);
    }
    if (loadMoreBtn) {
        loadMoreBtn.disabled = state;
    }
}

function toggleLoadMore(show) {
    if (!loadMoreBtn) return;
    loadMoreBtn.style.display = show ? 'inline-flex' : 'none';
}

function renderFiles() {
    if (!fileGrid) return;

    if (!filteredFiles.length) {
        const hasFilters = currentFilter !== 'all' || Boolean(currentSearch);
        const shouldShowLoading = isAwaitingRemoteUpdate || (isLoadingFiles && !hasCompletedInitialLoad);
        if (shouldShowLoading) {
            const loaderTitle = hasFilters ? 'Applying filters' : 'Loading assets';
            const loaderMessage = currentSearch
                ? 'Searching for matching assets...'
                : 'Retrieving assets from Google Drive. Please wait.';
            fileGrid.innerHTML = `
                <div class="no-results no-results--loading">
                    <i class="ri-loader-4-line"></i>
                    <h3>${loaderTitle}</h3>
                    <p>${loaderMessage}</p>
                </div>
            `;
        } else {
            const title = hasFilters ? 'No matching assets found' : 'No assets available';
            const message = hasFilters
                ? 'Please adjust your filter criteria or search query to find assets.'
                : 'No assets have been synchronized yet. Upload files via the API and refresh the dashboard.';
            fileGrid.innerHTML = `
                <div class="no-results">
                    <i class="ri-search-line"></i>
                    <h3>${title}</h3>
                    <p>${message}</p>
                </div>
            `;
        }
        return;
    }
    fileGrid.innerHTML = filteredFiles.map((file, index) => createFileCard(file, index + 1)).join('');
    fileGrid.querySelectorAll('.file-card').forEach((card) => {
        card.addEventListener('click', (event) => {
            if (event.target.closest('.file-action')) {
                return;
            }
            openFileModal(card.dataset.fileId);
        });
    });
    fileGrid.querySelectorAll('.file-action').forEach((action) => {
        action.addEventListener('click', (event) => event.stopPropagation());
    });
    fileGrid.querySelectorAll('.copy-btn').forEach((button) => button.addEventListener('click', handleCopyUrl));
    attachCardObservers();
}

function createFileCard(file, index = 0) {
    const fileType = fileTypes[file.type] || fileTypes.other;
    const fileTypeLabel = escapeHtml(fileType.displayName);
    const cdnUrl = escapeHtml(file.cdnUrl || '');
    const previewUrl = file.thumbnailUrl ? escapeHtml(file.thumbnailUrl) : '';
    const driveUrl = file.driveUrl ? escapeHtml(file.driveUrl) : '';
    const previewClasses = ['file-preview'];
    if (!file.thumbnailUrl) {
        previewClasses.push('placeholder');
    }
    const ordinal = Number(index) || 0;
    const serialLabel = ordinal ? `#${String(ordinal).padStart(2, '0')}` : '#--';
    const previewInner = file.thumbnailUrl
        ? `<img src="${previewUrl}" alt="${escapeHtml(file.name)} preview" loading="lazy" />`
        : `<i class="${fileType.icon}"></i>`;
    const metaParts = [];
    if (file.sizeDisplay) {
        metaParts.push(escapeHtml(file.sizeDisplay));
    }
    if (file.modifiedDisplay) {
        metaParts.push(escapeHtml(file.modifiedDisplay));
    }
    const metaText = metaParts.length ? metaParts.join(' &bull; ') : '--';
    const driveLink = driveUrl
        ? `<a class="file-action" href="${driveUrl}" target="_blank" rel="noopener" title="Open in Drive">
                <i class="ri-drive-line"></i>
            </a>`
        : '';
    return `
        <div class="file-card" data-file-id="${escapeHtml(file.id)}">
            <div class="${previewClasses.join(' ')}">
                <span class="file-counter">${serialLabel}</span>
                <span class="file-type-chip ${fileType.class}">${fileTypeLabel}</span>
                ${previewInner}
            </div>
            <div class="file-header">
                <div class="file-icon ${fileType.class}">
                    <i class="${fileType.icon}"></i>
                </div>
                <div class="file-info-main">
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-meta">${metaText}</div>
                </div>
            </div>
            <div class="file-footer file-footer--actions">
                <div class="file-actions">
                    <button type="button" class="file-action copy-btn" data-url="${cdnUrl}" title="Copy CDN URL">
                        <i class="ri-file-copy-line"></i>
                    </button>
                    <a class="file-action" href="${cdnUrl}" target="_blank" rel="noopener" title="Open CDN">
                        <i class="ri-external-link-line"></i>
                    </a>
                    ${driveLink}
                </div>
            </div>
        </div>
    `;
}

function updateFileCount() {
    if (!assetCount) return;
    if (!filteredFiles.length && (isAwaitingRemoteUpdate || (isLoadingFiles && !hasCompletedInitialLoad))) {
        assetCount.textContent = 'Retrieving assets...';
        return;
    }
    if (!filteredFiles.length && !isLoadingFiles) {
        assetCount.textContent = 'No assets available';
        return;
    }
    const loaded = filteredFiles.length;
    if (totalRemoteFiles) {
        if (loaded >= totalRemoteFiles) {
            assetCount.textContent = `${numberFormatter.format(totalRemoteFiles)} assets loaded`;
        } else {
            assetCount.textContent = `${numberFormatter.format(loaded)} of ${numberFormatter.format(totalRemoteFiles)} assets`;
        }
    } else {
        assetCount.textContent = `${numberFormatter.format(loaded)} assets`;
    }
}

function openFileModal(fileId) {
    if (!fileModal) return;
    const file = cdnFiles.find((item) => item.id === fileId);
    if (!file) {
        return;
    }
    const fileType = fileTypes[file.type] || fileTypes.other;
    const preview = file.thumbnailUrl
        ? `<div class="file-detail-preview"><img src="${escapeHtml(file.thumbnailUrl)}" alt="${escapeHtml(file.name)} preview" /></div>`
        : `<div class="file-detail-preview"><div class="file-icon ${fileType.class} large"><i class="${fileType.icon}"></i></div></div>`;
    modalTitle.textContent = file.name;
    modalBody.innerHTML = `
        <div class="file-detail-header">
            ${preview}
            <div class="file-detail-info">
                <h3>${escapeHtml(file.name)}</h3>
                <div class="file-detail-meta">
                    <span class="meta-item"><i class="ri-hard-drive-line"></i>${escapeHtml(file.sizeDisplay || 'Unknown size')}</span>
                    <span class="meta-item"><i class="ri-code-line"></i>${escapeHtml(file.mimeType || 'Unknown type')}</span>
                    <span class="meta-item"><i class="ri-calendar-line"></i>Created ${escapeHtml(file.createdDisplay || '—')}</span>
                </div>
            </div>
        </div>
        <div class="file-detail-sections">
            <div class="detail-section">
                <h4><i class="ri-link"></i>Links</h4>
                <div class="url-copy">
                    <div class="url-display">${escapeHtml(file.cdnUrl)}</div>
                    <button type="button" class="copy-btn" data-url="${escapeHtml(file.cdnUrl)}">
                        <i class="ri-file-copy-line"></i>
                        Copy CDN URL
                    </button>
                </div>
                <div class="url-copy" style="margin-top: var(--space-xs);">
                    <div class="url-display">${escapeHtml(file.driveUrl)}</div>
                    <button type="button" class="copy-btn" data-url="${escapeHtml(file.driveUrl)}">
                        <i class="ri-google-drive-line"></i>
                        Copy Drive URL
                    </button>
                </div>
            </div>
        </div>
    `;
    modalBody.querySelectorAll('.copy-btn').forEach((button) => button.addEventListener('click', handleCopyUrl));
    fileModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeFileModal() {
    if (!fileModal) return;
    fileModal.classList.remove('active');
    document.body.style.overflow = '';
}

function handleCopyUrl(event) {
    event.stopPropagation();
    const target = event.currentTarget || event.target;
    const button = target.closest('.copy-btn');
    if (!button) {
        return;
    }
    const url = button.dataset.url;
    copyToClipboard(url);
}

async function copyToClipboard(text) {
    if (!text) return;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
        }
        showNotification('URL copied to clipboard!', 'success');
    } catch (error) {
        console.error('Clipboard error:', error);
        showNotification('Unable to copy URL', 'error');
    }
}

function showNotification(message, type = 'success') {
    document.querySelectorAll('.notification').forEach((node) => node.remove());
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 3000);
}

function escapeHtml(value = '') {
    return value.replace(/[&<>"']/g, (char) => {
        switch (char) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return char;
        }
    });
}

function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = savedTheme || (prefersDark ? 'dark' : 'light');
    setTheme(theme);
}

function setupThemeToggle() {
    const toggles = document.querySelectorAll('[data-theme-toggle]');
    toggles.forEach((button) => {
        button.addEventListener('click', (event) => {
            event.preventDefault();
            toggleTheme();
        });
    });
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    const iconClass = theme === 'light' ? 'ri-moon-line' : 'ri-sun-line';
    document.querySelectorAll('[data-theme-icon]').forEach((icon) => {
        icon.className = iconClass;
    });
}

function setupHeaderScroll() {
    let ticking = false;
    function updateHeader() {
        const scrolled = window.scrollY > 120;
        const siteNavbar = document.getElementById('siteNavbar');
        const heroHeader = document.getElementById('heroHeader');
        if (siteNavbar) {
            siteNavbar.classList.toggle('site-navbar--fixed', scrolled);
        }
        if (heroHeader) {
            heroHeader.classList.toggle('hero-header--compact', scrolled);
        }
        ticking = false;
    }
    function requestTick() {
        if (!ticking) {
            requestAnimationFrame(updateHeader);
            ticking = true;
        }
    }
    window.addEventListener('scroll', requestTick);
    updateHeader();
}

document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        event.preventDefault();
        if (assetSearchInput) {
            assetSearchInput.focus();
        }
    }
});

document.addEventListener('mouseover', (event) => {
    const card = event.target.closest('.file-card');
    if (card) {
        card.style.transform = 'translateY(-2px)';
    }
});

document.addEventListener('mouseout', (event) => {
    const card = event.target.closest('.file-card');
    if (card) {
        card.style.transform = '';
    }
});

const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
        if (entry.isIntersecting) {
            entry.target.style.animation = 'fadeInUp 0.4s ease-out';
        }
    });
});

function attachCardObservers() {
    if (!observer || !fileGrid) return;
    fileGrid.querySelectorAll('.file-card').forEach((card) => observer.observe(card));
}

window.closeFileModal = closeFileModal;
window.copyToClipboard = copyToClipboard;

window.addEventListener('error', (event) => {
    console.error('Application error:', event.error);
});

if ('serviceWorker' in navigator) {
    console.log('Service worker support detected');
}


