// ⚠️ REPLACE THESE WITH YOUR ACTUAL KEYS FROM SUPABASE DASHBOARD
const SUPABASE_URL = 'https://yabshcncpymoqxbvgtjd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhYnNoY25jcHltb3F4YnZndGpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU0NTY5MzksImV4cCI6MjA4MTAzMjkzOX0.CSxMXKyyIg8T5d4TBntIt7RmrhYkemhKQE5GrmRiVx8';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const container = document.getElementById('drafts-container');
const refreshBtn = document.getElementById('refresh-btn');

async function fetchDrafts() {
    container.innerHTML = '<div class="loading">Loading drafts...</div>';
    
    // 1. Fetch Drafts joined with Trending News to get the original title/url
    const { data, error } = await supabase
        .from('draft_posts')
        .select(`
            id,
            gemini_draft,
            gemini_insight,
            created_at,
            trending_news (
                title,
                url,
                source_name
            )
        `)
        .eq('is_reviewed', false) // Only show unreviewed posts
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error fetching drafts:', error);
        container.innerHTML = `<div class="error">Error: ${error.message}</div>`;
        return;
    }

    renderDrafts(data);
}

function renderDrafts(drafts) {
    if (!drafts || drafts.length === 0) {
        container.innerHTML = '<div class="empty">No new drafts to review! 🎉</div>';
        return;
    }

    container.innerHTML = '';

    drafts.forEach(draft => {
        const news = draft.trending_news;
        const card = document.createElement('div');
        card.className = 'card';
        
        card.innerHTML = `
            <div class="news-meta">
                <span>${new Date(draft.created_at).toLocaleString()}</span>
                <span>Source: ${news.source_name}</span>
            </div>
            <h3 class="news-title">
                <a href="${news.url}" target="_blank" style="color:white;text-decoration:none;">${news.title} 🔗</a>
            </h3>
            
            <div class="insight-box">
                <strong>💡 Insight:</strong> ${draft.gemini_insight}
            </div>

            <textarea id="text-${draft.id}">${draft.gemini_draft}</textarea>

            <div class="actions">
                <button class="btn-copy" onclick="copyToClipboard('${draft.id}')">Copy</button>
                <button class="btn-approve" onclick="approveDraft('${draft.id}')">Approve & Save</button>
            </div>
        `;
        container.appendChild(card);
    });
}

// Save the edited text and mark as reviewed
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
        // Remove card from UI
        textarea.closest('.card').remove();
        // Check if empty
        if (container.children.length === 0) fetchDrafts();
    }
};

window.copyToClipboard = (id) => {
    const textarea = document.getElementById(`text-${id}`);
    navigator.clipboard.writeText(textarea.value);
    const btn = textarea.closest('.card').querySelector('.btn-copy');
    const originalText = btn.innerText;
    btn.innerText = 'Copied!';
    setTimeout(() => btn.innerText = originalText, 2000);
};

refreshBtn.addEventListener('click', fetchDrafts);

// Initial Load
fetchDrafts();