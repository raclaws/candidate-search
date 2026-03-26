// Store credentials in memory (lost on page refresh, works with serverless)
let authHeader = localStorage.getItem('authHeader');

const searchInput = document.getElementById('searchInput');
const resultsDiv = document.getElementById('results');
const loginSection = document.getElementById('loginSection');
const appSection = document.getElementById('appSection');
const loginError = document.getElementById('loginError');

// Pagination state
let currentSearch = '';
let currentOffset = 0;
let currentLimit = 20;
let totalRows = 0;
let isLoading = false;
let loadMoreButton = null;

// Check auth on load
function checkAuth() {
    if (authHeader) {
        showApp();
    } else {
        showLogin();
    }
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
    
    // Create Basic Auth header
    authHeader = 'Basic ' + btoa(username + ':' + password);
    localStorage.setItem('authHeader', authHeader);
    
    // Test auth with a request
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

// Debounce function
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Skeleton loading HTML
function renderSkeleton(count = 5) {
    let skeletonHtml = '';
    for (let i = 0; i < count; i++) {
        skeletonHtml += `
        <div class="candidate skeleton">
            <div class="skeleton-line" style="width: 60%;"></div>
            <div class="candidate-meta">
                <span class="skeleton-line" style="width: 20%;"></span>
                <span class="skeleton-line" style="width: 20%;"></span>
                <span class="skeleton-line" style="width: 15%;"></span>
                <span class="skeleton-line" style="width: 25%;"></span>
            </div>
            <div class="skeleton-skills">
                <div class="skeleton-skill skeleton"></div>
                <div class="skeleton-skill skeleton"></div>
                <div class="skeleton-skill skeleton"></div>
            </div>
            <div class="candidate-links">
                <span class="skeleton-line" style="width: 50px;"></span>
                <span class="skeleton-line" style="width: 40px;"></span>
            </div>
        </div>
        `;
    }
    return skeletonHtml;
}

// Perform search (first page)
async function search() {
    const name = searchInput.value.trim();
    if (!name) return;
    
    if (!authHeader) {
        showLogin();
        return;
    }
    
    currentSearch = name;
    currentOffset = 0;
    totalRows = 0;
    isLoading = true;
    
    // Clear previous results and show skeleton
    resultsDiv.innerHTML = '<div class="result-count">Searching...</div>' + renderSkeleton();
    
    try {
        const response = await fetch(`/api/candidates?name=${encodeURIComponent(name)}&offset=0&limit=${currentLimit}`, {
            headers: { 'Authorization': authHeader }
        });
        
        if (response.status === 401) {
            loginError.textContent = 'Session expired. Please login again.';
            loginError.classList.remove('hidden');
            showLogin();
            return;
        }
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Search failed');
        }
        
        renderResults(data, false);
    } catch (error) {
        resultsDiv.innerHTML = `<div class="error">Error: ${error.message}</div>`;
    } finally {
        isLoading = false;
    }
}

// Load more results
async function loadMore() {
    if (!authHeader || isLoading) return;
    
    isLoading = true;
    if (loadMoreButton) loadMoreButton.disabled = true;
    
    try {
        const response = await fetch(`/api/candidates?name=${encodeURIComponent(currentSearch)}&offset=${currentOffset}&limit=${currentLimit}`, {
            headers: { 'Authorization': authHeader }
        });
        
        if (response.status === 401) {
            loginError.textContent = 'Session expired. Please login again.';
            loginError.classList.remove('hidden');
            showLogin();
            return;
        }
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Load more failed');
        }
        
        renderResults(data, true);
    } catch (error) {
        resultsDiv.innerHTML += `<div class="error">Error loading more: ${error.message}</div>`;
    } finally {
        isLoading = false;
        if (loadMoreButton) loadMoreButton.disabled = false;
    }
}

// Render results (append if append = true)
function renderResults(data, append = false) {
    const candidates = data.list || [];
    const pageInfo = data.pageInfo || {};
    totalRows = pageInfo.totalRows || candidates.length;
    
    if (!append) {
        // First page
        if (candidates.length === 0) {
            resultsDiv.innerHTML = '<div class="empty-state">No candidates found</div>';
            return;
        }
        
        const countHtml = `<div class="result-count">Found ${totalRows} candidate${totalRows !== 1 ? 's' : ''}</div>`;
        const candidatesHtml = renderCandidateList(candidates);
        resultsDiv.innerHTML = countHtml + candidatesHtml;
    } else {
        // Append more candidates
        const candidatesHtml = renderCandidateList(candidates);
        // Remove existing load more button if present
        const existingButton = resultsDiv.querySelector('.load-more-button');
        if (existingButton) existingButton.remove();
        // Append new candidates
        resultsDiv.insertAdjacentHTML('beforeend', candidatesHtml);
    }
    
    // Update offset
    currentOffset += candidates.length;
    
    // Show load more button if there are more results
    if (currentOffset < totalRows) {
        const remaining = totalRows - currentOffset;
        const loadMoreHtml = `
            <div class="load-more-container" style="padding: 1.5rem; text-align: center;">
                <button class="load-more-button" onclick="loadMore()">
                    Load ${remaining > currentLimit ? currentLimit : remaining} more of ${remaining} remaining
                </button>
            </div>
        `;
        resultsDiv.insertAdjacentHTML('beforeend', loadMoreHtml);
        loadMoreButton = resultsDiv.querySelector('.load-more-button');
    } else if (!append) {
        // No more results, ensure no load button
        const existingButton = resultsDiv.querySelector('.load-more-button');
        if (existingButton) existingButton.remove();
    }
}

// Render candidate list HTML
function renderCandidateList(candidates) {
    return candidates.map(c => {
        const skills = (c['Programming Language (professionally used)'] || '')
            .split(/,|;/)
            .map(s => s.trim())
            .filter(s => s);
        
        const cloud = c['Cloud Expertise'] || '';
        if (cloud) skills.push(cloud);
        
        return `
            <div class="candidate">
                <div class="candidate-name">${escapeHtml(c['Full-Name'] || 'Unknown')}</div>
                <div class="candidate-meta">
                    <span>📧 ${escapeHtml(c.Email || 'N/A')}</span>
                    <span>📱 ${escapeHtml(c['Phone Number'] || 'N/A')}</span>
                    <span>💼 ${escapeHtml(c['Total Years of Experience'] || '?')} years</span>
                    <span>💰 ${formatSalary(c['(Full-time) Expected Salary (Nett in IDR)'])}</span>
                </div>
                <div class="candidate-skills">
                    ${skills.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('')}
                </div>
                <div class="candidate-links">
                    ${c['LinkedIn Link'] ? `<a href="${escapeHtml(c['LinkedIn Link'])}" target="_blank">LinkedIn</a>` : ''}
                    ${c['Upload CV'] ? `<a href="${escapeHtml(c['Upload CV'])}" target="_blank">CV</a>` : ''}
                    ${c['Portfolio Link (if any)'] ? `<a href="${escapeHtml(c['Portfolio Link (if any)'])}" target="_blank">Portfolio</a>` : ''}
                    ${c.DLink ? `<a href="${escapeHtml(c.DLink)}" target="_blank">Doss</a>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatSalary(salary) {
    if (!salary) return 'Salary not specified';
    const num = parseInt(salary);
    if (isNaN(num)) return escapeHtml(salary);
    return 'IDR ' + num.toLocaleString();
}

// Event listeners
searchInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') search();
});

// Debounced search on input (300ms)
const debouncedSearch = debounce(search, 300);
searchInput?.addEventListener('input', debouncedSearch);

// Check auth on page load
checkAuth();