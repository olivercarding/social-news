// ⚠️ REPLACE THESE WITH YOUR ACTUAL KEYS FROM SUPABASE DASHBOARD
const SUPABASE_URL = 'https://yabshcncpymoqxbvgtjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhYnNoY25jcHltb3F4YnZndGpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0NTY5MzksImV4cCI6MjA4MTAzMjkzOX0.CSxMXKyyIg8T5d4TBntIt7RmrhYkemhKQE5GrmRiVx8';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const container = document.getElementById('drafts-container');
const refreshBtn = document.getElementById('refresh-btn');

let currentTab = 'inbox'; // Default to 'inbox'

// --- Tab Switching Logic ---
window.switchTab = (tab) => {
    currentTab = tab;
    
    // Update UI classes for the tabs
    document.getElementById('tab-inbox').classList.toggle('active', tab === 'inbox');
    document.getElementById('tab-history').classList.toggle('active', tab === 'history');
    
    fetchDrafts();
};

// --- Fetch Logic (Handles both Inbox and History) ---
async function fetchDrafts() {
    container.innerHTML = '<div class="loading">Loading...</div>';
    
    // Determine which posts to fetch based on the tab
    // Inbox = is_reviewed is false
    // History = is_reviewed is true
    const isReviewed = currentTab === 'history';

    const { data, error } = await supabase
        .from('draft_posts')
        .select(`
            id,
            gemini_draft,
            gemini_insight,
            final_approved_post,
            created_at,
            posted_date,
            trending_news (
                title,
                url,
                source_name
            )
        `)
        .eq('is_reviewed', isReviewed) 
        .order(isReviewed ? 'posted_date' : 'created_at', { ascending: false }) // Sort history by posted date
        .limit(50); 

    if (error) {
        console.error('Error fetching drafts:', error);
        container.innerHTML = `<div class="error">Error: ${error.message}</div>`;
        return;
    }

    renderDrafts(data);
}

// --- Render Logic ---
function renderDrafts(drafts) {
    if (!drafts || drafts.length === 0) {
        container.innerHTML = `<div class="empty">${currentTab === 'inbox' ? 'No new drafts to review! 🎉' : 'No history found.'}</div>`;
        return;
    }

    container.innerHTML = '';

    drafts.forEach(draft => {
        const news = draft.trending_news;
        const card = document.createElement('div');
        
        // Use different styling for history items (green border)
        card.className = currentTab === 'history' ? 'card history-card' : 'card';
        
        // Logic: For history, show the FINAL text. For inbox, show the DRAFT.
        const textContent = currentTab === 'history' ? draft.final_approved_post : draft.gemini_draft;
        
        // Logic: Actions HTML changes based on tab
        let actionsHtml = '';
        
        if (currentTab === 'inbox') {
            // INBOX Buttons: Reject, Copy, Approve
            actionsHtml = `
                <button class="btn-reject" onclick="rejectDraft('${draft.id}')" style="background-color: #ef4444; color: white; margin-right: auto;">Reject</button> 
                <button class="btn-copy" onclick="copyToClipboard('${draft.id}')">Copy</button>
                <button class="btn-approve" onclick="approveDraft('${draft.id}')">Approve & Save</button>
            `;
        } else {
            // HISTORY Buttons: Just Copy (and show timestamp)
            const dateStr = draft.posted_date ? new Date(draft.posted_date).toLocaleDateString() : 'Unknown date';
            actionsHtml = `
                <span style="margin-right: auto; color: #10b981; font-size: 0.85rem;">✅ Approved on ${dateStr}</span>
                <button class="btn-copy" onclick="copyToClipboard('${draft.id}')">Copy Tweet</button>
            `;
        }

        // Build the Card HTML
        card.innerHTML = `
            <div class="news-meta">
                <span>${new Date(draft.created_at).toLocaleString()}</span>
                <span>Source: ${news?.source_name || 'Unknown'}</span>
            </div>
            <h3 class="news-title">
                <a href="${news?.url || '#'}" target="_blank" style="color:white;text-decoration:none;">${news?.title || 'Untitled'} 🔗</a>
            </h3>
            
            <div class="insight-box">
                <strong>💡 Insight:</strong> ${draft.gemini_insight || 'No insight available'}
            </div>

            <textarea id="text-${draft.id}" ${currentTab === 'history' ? 'readonly' : ''}>${textContent}</textarea>

            <div class="actions">
                ${actionsHtml}
            </div>
        `;
        container.appendChild(card);
    });
}

// --- Action: Approve ---
window.approveDraft = async (id) => {
    const textarea = document.getElementById(`text-${id}`);
    const newText = textarea.value;

    const { error } = await supabase
        .from('draft_posts')
        .update({ 
            final_approved_post: newText,
            is_reviewed: true,
            posted_date: new Date().toISOString()
        })
        .eq('id', id);

    if (error) {
        alert('Error saving: ' + error.message);
    } else {
        // Remove card from UI immediately
        textarea.closest('.card').remove();
        // Refresh if empty
        if (container.children.length === 0) fetchDrafts();
    }
};

// --- Action: Reject (Delete) ---
window.rejectDraft = async (id) => {
    if (!confirm('Are you sure you want to delete this draft? It will not be used for learning.')) return;

    const { error } = await supabase
        .from('draft_posts')
        .delete()
        .eq('id', id);

    if (error) {
        alert('Error deleting: ' + error.message);
    } else {
        const textarea = document.getElementById(`text-${id}`);
        if(textarea) {
             textarea.closest('.card').remove();
        }
        if (container.children.length === 0) fetchDrafts();
    }
};

// --- Action: Copy ---
window.copyToClipboard = (id) => {
    const textarea = document.getElementById(`text-${id}`);
    navigator.clipboard.writeText(textarea.value);
    
    // Visual feedback
    const btn = textarea.closest('.card').querySelector('.btn-copy');
    const originalText = btn.innerText;
    btn.innerText = 'Copied!';
    setTimeout(() => btn.innerText = originalText, 2000);
};

refreshBtn.addEventListener('click', fetchDrafts);

// Initial Load
fetchDrafts();