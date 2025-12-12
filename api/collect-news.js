import axios from 'axios';
import { supabase } from '../utils/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const CRYPTOPANIC_API_KEY = process.env.CRYPTOPANIC_API_KEY;
  if (!CRYPTOPANIC_API_KEY) {
    return res.status(500).json({ error: 'CRYPTOPANIC_API_KEY is not configured.' });
  }

  try {
    // 1. Fetch Trending News
    const apiUrl = `https://cryptopanic.com/api/v1/posts/?auth_token=${CRYPTOPANIC_API_KEY}&kind=news&filter=hot&public=true`;
    
    console.log('Fetching from CryptoPanic...');
    const response = await axios.get(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vercel-Function/1.0)' },
      timeout: 15000
    });
    
    const posts = response.data.results || [];
    if (posts.length === 0) {
      return res.status(200).json({ message: 'No new posts found in trending feed.' });
    }

    // 2. Deduplication (FIXED: Convert IDs to Strings)
    const newCpIds = posts.map(p => String(p.id)); // Force String

    const { data: existingRecords, error: selectError } = await supabase
      .from('trending_news')
      .select('cp_id')
      .in('cp_id', newCpIds);

    if (selectError) throw selectError;

    // Create a Set of existing IDs (as strings)
    const existingCpIds = new Set(existingRecords.map(r => String(r.cp_id)));

    // 3. Filter: New AND High Threshold
    const newsToInsert = posts
      .filter(p => !existingCpIds.has(String(p.id))) // Check against String Set
      .filter(p => {
        const votes = p.votes || {};
        const totalVotes = (votes.positive || 0) + (votes.negative || 0) + (votes.important || 0) + (votes.saved || 0) + (votes.lol || 0);
        
        // UPDATED THRESHOLD: Increased from 3 to 20
        return totalVotes >= 20; 
      })
      .map(p => ({
        cp_id: String(p.id), // Store as String
        title: p.title || 'Untitled',
        url: p.url || '',
        source_name: p.source?.title || 'Unknown',
        upvotes: p.votes?.positive || 0,
        sentiment: p.sentiment || 'neutral',
      }));

    // Remove duplicates within the current batch
    const uniqueNewsToInsert = Array.from(new Map(newsToInsert.map(item => [item.cp_id, item])).values());

    if (uniqueNewsToInsert.length === 0) {
      return res.status(200).json({ 
        message: 'No new high-quality posts found.',
        fetched: posts.length,
        already_existed: existingCpIds.size,
        threshold: '20+ votes'
      });
    }

    // 4. Insert & Trigger AI
    let successCount = 0;
    let duplicateCount = 0;

    for (const newsItem of uniqueNewsToInsert) {
      try {
        const { data: insertedData, error: insertError } = await supabase
          .from('trending_news')
          .insert(newsItem)
          .select()
          .single();

        if (insertError) {
          if (insertError.code === '23505') { // Duplicate key error
            duplicateCount++;
            continue;
          }
          console.error(`Error inserting ${newsItem.cp_id}:`, insertError.message);
          continue;
        }

        successCount++;

        // Call Gemini Generator
        await axios.post(
          `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/generate-draft`,
          { record: insertedData },
          {
            headers: {
              'Authorization': `Bearer ${process.env.WEBHOOK_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000
          }
        ).catch(err => console.error(`Draft gen failed for ${newsItem.cp_id}:`, err.message));

      } catch (err) {
        console.error(`Process error for ${newsItem.cp_id}:`, err.message);
      }
    }

    return res.status(200).json({ 
      message: 'Collector ran successfully.', 
      inserted: successCount,
      skipped_duplicates: duplicateCount 
    });

  } catch (error) {
    return res.status(500).json({ error: 'Collector failed', details: error.message });
  }
}