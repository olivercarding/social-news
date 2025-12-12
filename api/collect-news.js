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
    
    // FIX: Convert IDs to Strings explicitly to ensure matching works
    const newCpIds = posts.map(p => String(p.id));

    // Query Supabase to find which IDs already exist
    const { data: existingRecords, error: selectError } = await supabase
      .from('trending_news')
      .select('cp_id')
      .in('cp_id', newCpIds);

    if (selectError) {
      console.error('Supabase select error:', selectError);
      throw selectError;
    }

    // FIX: Create Set from String IDs
    const existingCpIds = new Set(existingRecords.map(r => String(r.cp_id)));
    console.log(`${existingCpIds.size} posts already exist in database`);

    // Filter posts: must be new AND meet a minimum vote threshold
    const newsToInsert = posts
      .filter(p => !existingCpIds.has(String(p.id))) // Check against String Set
      .filter(p => {
        // Safely access votes
        if (!p.votes || typeof p.votes !== 'object') {
          console.log(`Post ${p.id} has no votes object, including it anyway`);
          return true;
        }
        
        const totalVotes = (p.votes.positive || 0) + 
                          (p.votes.negative || 0) + 
                          (p.votes.important || 0) + 
                          (p.votes.saved || 0) + 
                          (p.votes.lol || 0);
        
        // UPDATED THRESHOLD: 5
        const meetsThreshold = totalVotes >= 5;
        
        if (!meetsThreshold) {
          console.log(`Post ${p.id} has only ${totalVotes} votes, skipping (Threshold: 5)`);
        }
        
        return meetsThreshold;
      })
      .map(p => ({
        cp_id: String(p.id), // FIX: Store as String
        title: p.title || 'Untitled',
        url: p.url || '',
        source_name: (p.source && p.source.title) ? p.source.title : 'Unknown',
        upvotes: (p.votes && p.votes.positive) ? p.votes.positive : 0,
        sentiment: p.sentiment || 'neutral',
      }));

    // Remove duplicates within the same batch
    const uniqueNewsToInsert = Array.from(
      new Map(newsToInsert.map(item => [item.cp_id, item])).values()
    );

    if (uniqueNewsToInsert.length === 0) {
      console.log('All posts filtered out (duplicates or low votes)');
      return res.status(200).json({ 
        message: 'All fetched news was either processed or below the vote threshold.',
        fetched: posts.length,
        existing: existingCpIds.size,
        threshold: '5+ votes'
      });
    }

    console.log(`Attempting to insert ${uniqueNewsToInsert.length} new posts`);

    // --- 3. Insert into Supabase and trigger draft generation ---
    let successCount = 0;
    let duplicateCount = 0;
    let draftGenerationErrors = 0;

    for (const newsItem of uniqueNewsToInsert) {
      try {
        // Insert the news item
        const { data: insertedData, error: insertError } = await supabase
          .from('trending_news')
          .insert(newsItem)
          .select()
          .single();

        if (insertError) {
          // Check if it's a duplicate key error
          if (insertError.code === '23505' || insertError.message.includes('duplicate key')) {
            console.log(`Duplicate detected for cp_id ${newsItem.cp_id}, skipping`);
            duplicateCount++;
            continue;
          } else {
            console.error(`Error inserting cp_id ${newsItem.cp_id}:`, insertError.message);
            continue;
          }
        }

        console.log(`Successfully inserted cp_id ${newsItem.cp_id}`);
        successCount++;

        // --- 4. Directly call generate-draft for this new item ---
        try {
          console.log(`Triggering draft generation for ${insertedData.id}...`);
          
          const draftResponse = await axios.post(
            `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/generate-draft`,
            {
              type: 'INSERT',
              table: 'trending_news',
              record: insertedData
            },
            {
              headers: {
                'Authorization': `Bearer ${process.env.WEBHOOK_SECRET_KEY}`,
                'Content-Type': 'application/json',
              },
              timeout: 30000, // 30 second timeout for Gemini API
            }
          );

          console.log(`Draft generated successfully for ${insertedData.id}`);
        } catch (draftError) {
          console.error(`Failed to generate draft for ${insertedData.id}:`, draftError.message);
          draftGenerationErrors++;
          // Continue processing other items even if draft generation fails
        }

      } catch (err) {
        console.error(`Exception processing cp_id ${newsItem.cp_id}:`, err.message);
      }
    }

    console.log(`Insert complete: ${successCount} successful, ${duplicateCount} duplicates, ${draftGenerationErrors} draft errors`);

    return res.status(200).json({ 
      message: 'News collector ran successfully.', 
      inserted_count: successCount,
      total_fetched: posts.length,
      skipped_duplicates: duplicateCount,
      drafts_generated: successCount - draftGenerationErrors,
      draft_generation_errors: draftGenerationErrors
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