let authHeader = localStorage.getItem('authHeader');

const searchInput = document.getElementById('searchInput');
const resultsDiv = document.getElementById('results');
const loginSection = document.getElementById('loginSection');
const appSection = document.getElementById('appSection');
const loginError = document.getElementById('loginError');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const filterChipsDiv = document.getElementById('filterChips');
const filterMenu = document.getElementById('filterMenu');

// Pagination state
let currentOffset = 0;
let currentLimit = 20;
let totalRows = 0;
let isLoading = false;
let loadMoreButton = null;

// Filter state
let activeFilters = [];

const FILTER_DEFINITIONS = {
    lang: { label: 'Language', type: 'text', placeholder: 'e.g. Python' },
    cloud: { label: 'Cloud', type: 'text', placeholder: 'e.g. AWS' },
    experience: { label: 'Experience (yrs)', type: 'range' },
    expectedSalary: { label: 'Expected Salary', type: 'range' },
    currentSalary: { label: 'Current Salary', type: 'range' },
    arrangement: { label: 'Arrangement', type: 'select', options: ['Remote', 'Hybrid', 'On-Site'] },
    notice: { label: 'Notice Period', type: 'select', options: ['<1 Month', '1 Month', '2 Months', '3 Months'] },
    position: { label: 'Position', type: 'text', placeholder: 'e.g. ML Engineer' },
    tools: { label: 'Tools', type: 'text', placeholder: 'e.g. Docker' }
};

// Auth
function checkAuth() {
    if (authHeader) { showApp(); } else { showLogin(); }
}

function showLogin() {
    loginSection.classList.remove('hidden');
    appSection.classList.add('hidden');
    appSection.style.display = 'none';
    authHeader = null;
    localStorage.removeItem('authHeader');
}

function showApp() {
    loginSection.classList.add('hidden');
    appSection.classList.remove('hidden');
    appSection.style.display = '';
    searchInput?.focus();
}

function login() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    authHeader = 'Basic ' + btoa(username + ':' + password);
    localStorage.setItem('authHeader', authHeader);

    fetch('/api/candidates?limit=1', {
        headers: { 'Authorization': authHeader }
    }).then(res => {
        if (res.ok) {
            loginError.classList.add('hidden');
            showApp();
        } else {
            loginError.textContent = 'Invalid credentials';
            loginError.classList.remove('hidden');
            authHeader = null;
            localStorage.removeItem('authHeader');
        }
    }).catch(() => {
        loginError.textContent = 'Login failed';
        loginError.classList.remove('hidden');
        authHeader = null;
        localStorage.removeItem('authHeader');
    });
}

function logout() {
    authHeader = null;
    localStorage.removeItem('authHeader');
    showLogin();
}

// Filter menu
function toggleFilterMenu() {
    filterMenu.classList.toggle('hidden');
}

function closeFilterMenu() {
    filterMenu.classList.add('hidden');
}

function addFilter(key) {
    if (activeFilters.find(f => f.key === key)) {
        closeFilterMenu();
        return;
    }
    const def = FILTER_DEFINITIONS[key];
    const filter = { key, value: '', min: '', max: '' };
    activeFilters.push(filter);
    renderFilterChips();
    closeFilterMenu();
}

function removeFilter(key) {
    activeFilters = activeFilters.filter(f => f.key !== key);
    renderFilterChips();
    triggerSearch();
}

function renderFilterChips() {
    filterChipsDiv.innerHTML = activeFilters.map(f => {
        const def = FILTER_DEFINITIONS[f.key];
        let inputHtml = '';

        if (def.type === 'text') {
            inputHtml = `<input type="text" placeholder="${def.placeholder}" value="${escapeHtml(f.value)}" onchange="updateFilter('${f.key}', this.value)" onkeypress="if(event.key==='Enter')triggerSearch()">`;
        } else if (def.type === 'range') {
            inputHtml = `<span class="filter-chip-range">
                <input type="number" placeholder="Min" value="${f.min}" onchange="updateFilterRange('${f.key}', 'min', this.value)" onkeypress="if(event.key==='Enter')triggerSearch()">
                <span>–</span>
                <input type="number" placeholder="Max" value="${f.max}" onchange="updateFilterRange('${f.key}', 'max', this.value)" onkeypress="if(event.key==='Enter')triggerSearch()">
            </span>`;
        } else if (def.type === 'select') {
            const opts = def.options.map(o => `<option value="${o}" ${f.value === o ? 'selected' : ''}>${o}</option>`).join('');
            inputHtml = `<select onchange="updateFilter('${f.key}', this.value); triggerSearch()"><option value="">Any</option>${opts}</select>`;
        }

        return `<div class="filter-chip">
            <span class="filter-chip-label">${def.label}</span>
            ${inputHtml}
            <button class="filter-chip-remove" onclick="removeFilter('${f.key}')">&times;</button>
        </div>`;
    }).join('');
}

function updateFilter(key, value) {
    const f = activeFilters.find(f => f.key === key);
    if (f) f.value = value;
}

function updateFilterRange(key, which, value) {
    const f = activeFilters.find(f => f.key === key);
    if (f) f[which] = value;
}

// Build query params from filters
function buildFilterParams() {
    const params = new URLSearchParams();
    const name = searchInput.value.trim();
    if (name) params.set('name', name);

    for (const f of activeFilters) {
        const def = FILTER_DEFINITIONS[f.key];
        if (def.type === 'text' && f.value) {
            params.set(f.key === 'lang' ? 'lang' : f.key === 'cloud' ? 'cloud' : f.key === 'position' ? 'position' : 'tools', f.value);
        } else if (def.type === 'select' && f.value) {
            params.set(f.key === 'arrangement' ? 'arrangement' : 'notice', f.value);
        } else if (def.type === 'range') {
            if (f.key === 'experience') {
                if (f.min) params.set('expMin', f.min);
                if (f.max) params.set('expMax', f.max);
            } else if (f.key === 'expectedSalary') {
                if (f.min) params.set('salaryMin', f.min);
                if (f.max) params.set('salaryMax', f.max);
            } else if (f.key === 'currentSalary') {
                if (f.min) params.set('currentSalaryMin', f.min);
                if (f.max) params.set('currentSalaryMax', f.max);
            }
        }
    }
    return params;
}

// Debounce
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

// Skeleton loading
function renderSkeleton(count = 5) {
    let html = '';
    for (let i = 0; i < count; i++) {
        html += `<div class="candidate skeleton">
            <div class="skeleton-line" style="width: 60%;"></div>
            <div class="candidate-meta"><span class="skeleton-line" style="width: 20%;"></span><span class="skeleton-line" style="width: 20%;"></span></div>
            <div class="skeleton-skills"><div class="skeleton-skill skeleton"></div><div class="skeleton-skill skeleton"></div></div>
        </div>`;
    }
    return html;
}

// Search
function triggerSearch() {
    search();
}

async function search() {
    const params = buildFilterParams();
    if (params.toString() === '' && !searchInput.value.trim()) return;

    if (!authHeader) { showLogin(); return; }

    currentOffset = 0;
    totalRows = 0;
    isLoading = true;
    resultsDiv.innerHTML = '<div class="result-count">Searching...</div>' + renderSkeleton();

    try {
        params.set('offset', '0');
        params.set('limit', String(currentLimit));
        const response = await fetch(`/api/candidates?${params.toString()}`, {
            headers: { 'Authorization': authHeader }
        });

        if (response.status === 401) {
            loginError.textContent = 'Session expired. Please login again.';
            loginError.classList.remove('hidden');
            showLogin();
            return;
        }

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Search failed');
        renderResults(data, false);
    } catch (error) {
        resultsDiv.innerHTML = `<div class="error">Error: ${error.message}</div>`;
    } finally {
        isLoading = false;
    }
}

async function loadMore() {
    if (!authHeader || isLoading) return;
    isLoading = true;
    if (loadMoreButton) loadMoreButton.disabled = true;

    try {
        const params = buildFilterParams();
        params.set('offset', String(currentOffset));
        params.set('limit', String(currentLimit));
        const response = await fetch(`/api/candidates?${params.toString()}`, {
            headers: { 'Authorization': authHeader }
        });

        if (response.status === 401) {
            loginError.textContent = 'Session expired. Please login again.';
            loginError.classList.remove('hidden');
            showLogin();
            return;
        }

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Load more failed');
        renderResults(data, true);
    } catch (error) {
        resultsDiv.innerHTML += `<div class="error">Error loading more: ${error.message}</div>`;
    } finally {
        isLoading = false;
        if (loadMoreButton) loadMoreButton.disabled = false;
    }
}

// Render results
function renderResults(data, append) {
    const candidates = data.list || [];
    const pageInfo = data.pageInfo || {};
    totalRows = pageInfo.totalRows || candidates.length;

    if (!append) {
        if (candidates.length === 0) {
            resultsDiv.innerHTML = '<div class="empty-state">No candidates found</div>';
            return;
        }
        const countHtml = `<div class="result-count">Found ${totalRows} candidate${totalRows !== 1 ? 's' : ''}</div>`;
        resultsDiv.innerHTML = countHtml + renderCandidateList(candidates);
    } else {
        const existing = resultsDiv.querySelector('.load-more-container');
        if (existing) existing.remove();
        resultsDiv.insertAdjacentHTML('beforeend', renderCandidateList(candidates));
    }

    currentOffset += candidates.length;

    if (currentOffset < totalRows) {
        const remaining = totalRows - currentOffset;
        const loadMoreHtml = `<div class="load-more-container">
            <button class="load-more-button" onclick="loadMore()">Load ${remaining > currentLimit ? currentLimit : remaining} more of ${remaining} remaining</button>
        </div>`;
        resultsDiv.insertAdjacentHTML('beforeend', loadMoreHtml);
        loadMoreButton = resultsDiv.querySelector('.load-more-button');
    }
}

// Render candidate cards
function renderCandidateList(candidates) {
    return candidates.map(c => {
        const langs = (c['Programming Language (professionally used)'] || '')
            .split(/,|;/)
            .map(s => s.trim())
            .filter(s => s);

        const tools = (c['Other professional related tools used'] || '')
            .split(/,|;/)
            .map(s => s.trim())
            .filter(s => s);

        const cloud = c['Cloud Expertise'] || '';
        const position = c['Current Formal Positions'] || '';
        const arrangement = c['Working arrangement preferences'] || '';
        const notice = c['(Full-time) Notice Period'] || '';
        const currentSalary = c['(Full-time) Current Salary (Nett in IDR)'];
        const expectedSalary = c['(Full-time) Expected Salary (Nett in IDR)'];

        const email = c.Email || '';
        const emailLink = formatEmailLink(email);
        const emailHtml = emailLink
            ? `<a href="${escapeHtml(emailLink)}" target="_blank">📧 ${escapeHtml(email)}</a>`
            : `📧 ${escapeHtml(email || 'N/A')}`;

        const phone = c['Phone Number'] || '';
        const waLink = formatWhatsAppLink(phone);
        const phoneHtml = waLink
            ? `<a href="${escapeHtml(waLink)}" target="_blank">📱 ${escapeHtml(phone)}</a>`
            : `📱 ${escapeHtml(phone || 'N/A')}`;

        const badgesHtml = [
            arrangement ? `<span class="badge badge-arrangement">${escapeHtml(arrangement)}</span>` : '',
            notice ? `<span class="badge badge-notice">${escapeHtml(notice)}</span>` : '',
            cloud ? `<span class="badge badge-cloud">☁️ ${escapeHtml(cloud)}</span>` : ''
        ].filter(b => b).join('');

        const salaryHtml = (currentSalary || expectedSalary) ? `<div class="candidate-salary">
            💰 ${currentSalary ? `<span class="salary-current">Current: ${formatSalary(currentSalary)}</span>` : ''}
            ${currentSalary && expectedSalary ? '<span class="salary-arrow">→</span>' : ''}
            ${expectedSalary ? `<span class="salary-expected">Expected: ${formatSalary(expectedSalary)}</span>` : ''}
        </div>` : '';

        const langsHtml = langs.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('');
        const toolsHtml = tools.map(s => `<span class="skill-tag-tool">${escapeHtml(s)}</span>`).join('');

        return `<div class="candidate">
            <div class="candidate-name">${escapeHtml(c['Full-Name'] || 'Unknown')}</div>
            ${position ? `<div class="candidate-position">${escapeHtml(position)}</div>` : ''}
            <div class="candidate-badges">${badgesHtml}</div>
            <div class="candidate-meta">
                <span>${emailHtml}</span>
                <span>${phoneHtml}</span>
                <span>💼 ${escapeHtml(c['Total Years of Experience'] || '?')} years</span>
            </div>
            ${salaryHtml}
            <div class="candidate-skills">${langsHtml}${toolsHtml}</div>
            <div class="candidate-links">
                ${c['LinkedIn Link'] ? `<a href="${escapeHtml(c['LinkedIn Link'])}" target="_blank">LinkedIn</a>` : ''}
                ${c['Upload CV'] ? `<a href="${escapeHtml(c['Upload CV'])}" target="_blank">CV</a>` : ''}
                ${c['Portfolio Link (if any)'] ? `<a href="${escapeHtml(c['Portfolio Link (if any)'])}" target="_blank">Portfolio</a>` : ''}
                <a href="/candidate/${c.Id}" target="_blank" class="share-link" onclick="event.preventDefault(); copyProfileLink(${c.Id}, this)">Share</a>
            </div>
        </div>`;
    }).join('');
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatSalary(salary) {
    if (!salary) return '';
    const num = parseInt(salary);
    if (isNaN(num)) return escapeHtml(salary);
    return 'IDR ' + num.toLocaleString();
}

function formatWhatsAppLink(phone) {
    if (!phone) return null;
    let cleaned = phone.trim();
    const hasPlus = cleaned.startsWith('+');
    cleaned = cleaned.replace(/\D/g, '');
    if (cleaned.startsWith('62')) return `https://wa.me/${cleaned}`;
    if (cleaned.startsWith('0')) return `https://wa.me/62${cleaned.slice(1)}`;
    if (cleaned.startsWith('8') && cleaned.length >= 9) return `https://wa.me/62${cleaned}`;
    if (hasPlus) return `https://wa.me/${cleaned}`;
    return null;
}

function formatEmailLink(email) {
    if (!email) return null;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return `mailto:${email.trim()}`;
    return null;
}

function copyProfileLink(id, el) {
    const url = `${window.location.origin}/candidate/${id}`;
    navigator.clipboard.writeText(url).then(() => {
        const original = el.textContent;
        el.textContent = 'Copied!';
        setTimeout(() => { el.textContent = original; }, 1500);
    }).catch(() => {
        window.open(`/candidate/${id}`, '_blank');
    });
}

// Event listeners
searchInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') search();
});

const debouncedSearch = debounce(search, 300);
searchInput?.addEventListener('input', debouncedSearch);

usernameInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
});
passwordInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
});

// Close filter menu on outside click
document.addEventListener('click', (e) => {
    if (!e.target.closest('.add-filter-wrapper')) {
        closeFilterMenu();
    }
});

checkAuth();
