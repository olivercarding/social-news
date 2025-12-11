import axios from 'axios';
import { supabase } from '../utils/supabase.js';

// Vercel Cron Jobs call this function with an HTTP GET request
export default async function handler(req, res) {
  // A simple guard to ensure the correct method is used
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const CRYPTOPANIC_API_KEY = process.env.CRYPTOPANIC_API_KEY;

  if (!CRYPTOPANIC_API_KEY) {
    return res.status(500).json({ error: 'CRYPTOPANIC_API_KEY is not configured.' });
  }

  try {
    // --- 1. Fetch Trending News from CryptoPanic ---
    // Using filter=hot and kind=news to get the most discussed articles
    const apiUrl = `https://cryptopanic.com/api/v1/posts/?auth=${CRYPTOPANIC_API_KEY}&kind=news&filter=hot&public=true`;
    
    const response = await axios.get(apiUrl);
    const posts = response.data.results || [];
    
    if (posts.length === 0) {
      return res.status(200).json({ message: 'No new posts found in trending feed.' });
    }

    // --- 2. Deduplication and Secondary Filtering ---
    
    const newCpIds = posts.map(p => p.id);

    // Query Supabase to find which IDs already exist
    const { data: existingRecords, error: selectError } = await supabase
      .from('trending_news')
      .select('cp_id')
      .in('cp_id', newCpIds);

    if (selectError) throw selectError;

    const existingCpIds = new Set(existingRecords.map(r => r.cp_id));

    // Filter posts: must be new AND meet a minimum vote threshold (e.g., at least 10 total votes)
    const newsToInsert = posts
      .filter(p => !existingCpIds.has(p.id))
      .filter(p => (p.votes.positive + p.votes.negative + p.votes.important + p.votes.saved + p.votes.lol) >= 10) 
      .map(p => ({
        cp_id: p.id,
        title: p.title,
        url: p.url,
        source_name: p.source.title,
        upvotes: p.votes.positive,
        sentiment: p.sentiment,
        // Other fields like is_processed will default to FALSE in Postgres
      }));

    if (newsToInsert.length === 0) {
      return res.status(200).json({ message: 'All fetched news was either processed or below the vote threshold.' });
    }

    // --- 3. Bulk Insert into Supabase (Triggers the Gemini Function) ---
    const { error: insertError } = await supabase
      .from('trending_news')
      .insert(newsToInsert)
      .select(); 

    if (insertError) throw insertError;

    return res.status(200).json({ 
      message: 'News collector ran successfully.', 
      inserted_count: newsToInsert.length 
    });

  } catch (error) {
    console.error('Collector execution error:', error.message);
    // Respond with a more descriptive error for debugging
    return res.status(500).json({ error: 'Failed to run news collector', details: error.message });
  }
}