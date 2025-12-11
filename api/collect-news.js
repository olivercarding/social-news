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
    const apiUrl = `https://cryptopanic.com/api/v1/posts/?auth_token=${CRYPTOPANIC_API_KEY}&kind=news&filter=hot&public=true`;
    
    console.log('Fetching from CryptoPanic...');
    
    let response;
    try {
      response = await axios.get(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Vercel-Function/1.0)',
        },
        timeout: 15000, // 15 second timeout
        validateStatus: function (status) {
          // Accept any status code so we can handle it ourselves
          return status < 500;
        }
      });
    } catch (axiosError) {
      console.error('Axios request failed:', axiosError.message);
      throw axiosError;
    }

    // Handle rate limiting specifically
    if (response.status === 429) {
      console.error('CryptoPanic rate limit hit (429)');
      const retryAfter = response.headers['retry-after'] || 60;
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        message: 'CryptoPanic API rate limit reached. Please wait before trying again.',
        retry_after_seconds: retryAfter
      });
    }

    // Handle other non-200 responses
    if (response.status !== 200) {
      console.error('CryptoPanic returned status:', response.status);
      console.error('Response data:', JSON.stringify(response.data));
      return res.status(response.status).json({
        error: 'CryptoPanic API error',
        status: response.status,
        details: response.data
      });
    }
    
    console.log('CryptoPanic response status:', response.status);
    
    // Validate response structure
    if (!response.data || !Array.isArray(response.data.results)) {
      console.error('Invalid response structure from CryptoPanic:', response.data);
      return res.status(500).json({
        error: 'Invalid API response structure',
        details: 'Expected an array of posts in results field'
      });
    }

    const posts = response.data.results;
    
    if (posts.length === 0) {
      console.log('No posts found in response');
      return res.status(200).json({ message: 'No new posts found in trending feed.' });
    }

    console.log(`Found ${posts.length} posts from CryptoPanic`);

    // --- 2. Deduplication and Secondary Filtering ---
    
    const newCpIds = posts.map(p => p.id);

    // Query Supabase to find which IDs already exist
    const { data: existingRecords, error: selectError } = await supabase
      .from('trending_news')
      .select('cp_id')
      .in('cp_id', newCpIds);

    if (selectError) {
      console.error('Supabase select error:', selectError);
      throw selectError;
    }

    const existingCpIds = new Set(existingRecords.map(r => r.cp_id));
    console.log(`${existingCpIds.size} posts already exist in database`);

    // Filter posts: must be new AND meet a minimum vote threshold
    // Add robust null/undefined checks for votes object
    const newsToInsert = posts
      .filter(p => !existingCpIds.has(p.id))
      .filter(p => {
        // Safely access votes - some posts might not have votes object
        if (!p.votes || typeof p.votes !== 'object') {
          console.log(`Post ${p.id} has no votes object, skipping`);
          return false;
        }
        
        const totalVotes = (p.votes.positive || 0) + 
                          (p.votes.negative || 0) + 
                          (p.votes.important || 0) + 
                          (p.votes.saved || 0) + 
                          (p.votes.lol || 0);
        return totalVotes >= 10;
      })
      .map(p => ({
        cp_id: p.id,
        title: p.title || 'Untitled',
        url: p.url || '',
        source_name: (p.source && p.source.title) ? p.source.title : 'Unknown',
        upvotes: (p.votes && p.votes.positive) ? p.votes.positive : 0,
        sentiment: p.sentiment || 'neutral',
      }));

    if (newsToInsert.length === 0) {
      console.log('All posts filtered out (duplicates or low votes)');
      return res.status(200).json({ 
        message: 'All fetched news was either processed or below the vote threshold.',
        fetched: posts.length,
        existing: existingCpIds.size
      });
    }

    console.log(`Inserting ${newsToInsert.length} new posts`);

    // --- 3. Bulk Insert into Supabase (Triggers the Gemini Function) ---
    const { error: insertError } = await supabase
      .from('trending_news')
      .insert(newsToInsert)
      .select(); 

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      throw insertError;
    }

    console.log('Successfully inserted posts');

    return res.status(200).json({ 
      message: 'News collector ran successfully.', 
      inserted_count: newsToInsert.length,
      total_fetched: posts.length
    });

  } catch (error) {
    console.error('Collector execution error:', error.message);
    console.error('Error stack:', error.stack);
    
    // More detailed error for axios errors
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', JSON.stringify(error.response.data));
      return res.status(500).json({ 
        error: 'CryptoPanic API request failed',
        status: error.response.status,
        details: error.response.data
      });
    }
    
    // Respond with a more descriptive error for debugging
    return res.status(500).json({ 
      error: 'Failed to run news collector', 
      details: error.message 
    });
  }
}