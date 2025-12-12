import axios from 'axios';
import { supabase } from '../utils/supabase.js';

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
    // Using filter=hot to ensure we only get relevant, high-velocity news
    const apiUrl = `https://cryptopanic.com/api/developer/v2/posts/?auth_token=${CRYPTOPANIC_API_KEY}&kind=news&filter=hot&public=true`;
    
    console.log('Fetching from CryptoPanic v2 API...');
    
    const response = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Vercel-Function/1.0)',
      },
      timeout: 15000,
      maxRedirects: 0,
    });
    
    if (!response.data || !Array.isArray(response.data.results)) {
      console.error('Invalid response structure from CryptoPanic');
      return res.status(500).json({ error: 'Invalid API response structure' });
    }

    const posts = response.data.results;
    
    if (posts.length === 0) {
      console.log('No posts found in response');
      return res.status(200).json({ message: 'No new posts found in trending feed.' });
    }

    // --- 2. Deduplication and Secondary Filtering ---
    
    // Convert IDs to Strings explicitly to ensure matching works
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

    // Create Set from String IDs for fast lookup
    const existingCpIds = new Set(existingRecords.map(r => String(r.cp_id)));

    // Filter posts: New AND meet your vote threshold
    const newsToInsert = posts
      .filter(p => !existingCpIds.has(String(p.id)))
      .filter(p => {
        // Safely access votes
        if (!p.votes || typeof p.votes !== 'object') return true;
        
        const totalVotes = (p.votes.positive || 0) + 
                          (p.votes.negative || 0) + 
                          (p.votes.important || 0) + 
                          (p.votes.saved || 0) + 
                          (p.votes.lol || 0);
        
        // YOUR THRESHOLD: 5
        return totalVotes >= 5;
      })
      .map(p => ({
        cp_id: String(p.id),
        title: p.title || 'Untitled',
        url: p.url || '',
        source_name: (p.source && p.source.title) ? p.source.title : 'Unknown',
        upvotes: (p.votes && p.votes.positive) ? p.votes.positive : 0,
        sentiment: p.sentiment || 'neutral',
      }));

    // Remove duplicates within the batch itself
    const uniqueNewsToInsert = Array.from(
      new Map(newsToInsert.map(item => [item.cp_id, item])).values()
    );

    if (uniqueNewsToInsert.length === 0) {
      return res.status(200).json({ 
        message: 'No new posts found above threshold (or all duplicates).',
        fetched: posts.length,
        existing: existingCpIds.size,
      });
    }

    console.log(`Processing ${uniqueNewsToInsert.length} new items...`);

    // --- 3. Insert and Trigger AI ---
    let successCount = 0;
    let duplicateCount = 0;
    let draftGenerationErrors = 0;

    // Define your project URL for the internal API call
    // FIX: Hardcoded to ensure Cron Jobs can find the path
    const PROJECT_URL = 'https://social-news-eight.vercel.app';

    for (const newsItem of uniqueNewsToInsert) {
      try {
        // A. Insert into Supabase
        const { data: insertedData, error: insertError } = await supabase
          .from('trending_news')
          .insert(newsItem)
          .select()
          .single();

        if (insertError) {
          if (insertError.code === '23505') { // Duplicate key
            duplicateCount++;
            continue;
          } else {
            console.error(`Error inserting cp_id ${newsItem.cp_id}:`, insertError.message);
            continue;
          }
        }

        successCount++;

        // B. Trigger the Draft Generator Manually
        try {
          console.log(`Triggering draft for: ${insertedData.title}`);
          
          await axios.post(
            `${PROJECT_URL}/api/generate-draft`,
            { 
              // Mimic the structure the generator expects (usually from webhook)
              record: insertedData 
            },
            {
              headers: {
                'Authorization': `Bearer ${process.env.WEBHOOK_SECRET_KEY}`,
                'Content-Type': 'application/json',
              },
              timeout: 25000, // 25s timeout to prevent cron timeouts
            }
          );
          
          console.log(`Draft generated successfully.`);
        } catch (draftError) {
          console.error(`Draft gen failed for ${insertedData.id}:`, draftError.message);
          draftGenerationErrors++;
        }

      } catch (err) {
        console.error(`Process error for ${newsItem.cp_id}:`, err.message);
      }
    }

    return res.status(200).json({ 
      message: 'Collector run complete.', 
      inserted: successCount,
      duplicates_skipped: duplicateCount,
      drafts_generated: successCount - draftGenerationErrors,
      draft_errors: draftGenerationErrors
    });

  } catch (error) {
    console.error('Collector fatal error:', error.message);
    return res.status(500).json({ error: 'Collector failed', details: error.message });
  }
}