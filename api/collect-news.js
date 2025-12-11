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
    // --- 1. Fetch Trending News from CryptoPanic v2 API ---
    const apiUrl = `https://cryptopanic.com/api/developer/v2/posts/?auth_token=${CRYPTOPANIC_API_KEY}&kind=news&filter=hot&public=true`;
    
    console.log('Fetching from CryptoPanic v2 API...');
    
    const response = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Vercel-Function/1.0)',
      },
      timeout: 15000,
      maxRedirects: 0,
    });
    
    console.log('CryptoPanic response status:', response.status);
    
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

    // Filter posts: must be new AND meet a minimum vote threshold (3+ votes)
    const newsToInsert = posts
      .filter(p => !existingCpIds.has(p.id))
      .filter(p => {
        // Safely access votes
        if (!p.votes || typeof p.votes !== 'object') {
          console.log(`Post ${p.id} has no votes object, including it anyway`);
          return true; // Include posts without votes
        }
        
        const totalVotes = (p.votes.positive || 0) + 
                          (p.votes.negative || 0) + 
                          (p.votes.important || 0) + 
                          (p.votes.saved || 0) + 
                          (p.votes.lol || 0);
        
        const meetsThreshold = totalVotes >= 3;
        
        if (!meetsThreshold) {
          console.log(`Post ${p.id} has only ${totalVotes} votes, skipping`);
        }
        
        return meetsThreshold;
      })
      .map(p => ({
        cp_id: p.id,
        title: p.title || 'Untitled',
        url: p.url || '',
        source_name: (p.source && p.source.title) ? p.source.title : 'Unknown',
        upvotes: (p.votes && p.votes.positive) ? p.votes.positive : 0,
        sentiment: p.sentiment || 'neutral',
      }));

    // Remove duplicates within the same batch (in case CryptoPanic returns dupes)
    const uniqueNewsToInsert = Array.from(
      new Map(newsToInsert.map(item => [item.cp_id, item])).values()
    );

    if (uniqueNewsToInsert.length === 0) {
      console.log('All posts filtered out (duplicates or low votes)');
      return res.status(200).json({ 
        message: 'All fetched news was either processed or below the vote threshold.',
        fetched: posts.length,
        existing: existingCpIds.size,
        threshold: '3+ votes'
      });
    }

    console.log(`Attempting to insert ${uniqueNewsToInsert.length} new posts`);

    // --- 3. Upsert into Supabase with ON CONFLICT handling ---
    // Using upsert with onConflict to gracefully handle any race conditions
    const { data: insertedData, error: insertError } = await supabase
      .from('trending_news')
      .upsert(uniqueNewsToInsert, { 
        onConflict: 'cp_id',
        ignoreDuplicates: true // Skip duplicates instead of throwing error
      })
      .select(); 

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      throw insertError;
    }

    const actualInsertCount = insertedData ? insertedData.length : 0;
    console.log(`Successfully inserted ${actualInsertCount} posts`);

    return res.status(200).json({ 
      message: 'News collector ran successfully.', 
      inserted_count: actualInsertCount,
      total_fetched: posts.length,
      skipped_duplicates: uniqueNewsToInsert.length - actualInsertCount
    });

  } catch (error) {
    console.error('Collector execution error:', error.message);
    console.error('Error stack:', error.stack);
    
    if (error.response) {
      console.error('API Response Status:', error.response.status);
      console.error('API Response Data:', JSON.stringify(error.response.data));
      
      if (error.response.status === 429) {
        const retryAfter = error.response.headers['retry-after'] || 60;
        return res.status(429).json({ 
          error: 'Rate limit exceeded',
          message: 'CryptoPanic API rate limit reached. Please wait before trying again.',
          retry_after_seconds: retryAfter
        });
      }
      
      return res.status(500).json({ 
        error: 'CryptoPanic API request failed',
        status: error.response.status,
        details: error.response.data
      });
    }
    
    return res.status(500).json({ 
      error: 'Failed to run news collector', 
      details: error.message 
    });
  }
}