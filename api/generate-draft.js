import { GoogleGenAI } from '@google/genai';
import { supabase } from '../utils/supabase.js';

// Initialize Gemini client (uses GEMINI_API_KEY from Vercel ENV)
const ai = new GoogleGenAI({});

// Define the required structure for Gemini's output
const responseSchema = {
  type: "object",
  properties: {
    insight: {
      type: "string",
      description: "A concise, 1-2 sentence key takeaway analysis of the news for the user's review.",
    },
    draft_tweet: {
      type: "string",
      description: "The personalized post, max 240 characters, emulating the user's past style and including 2-3 relevant hashtags.",
    }
  },
  required: ["insight", "draft_tweet"],
};

export default async function handler(req, res) {
  // --- 1. Security & Method Check ---
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Only POST is accepted.' });
  }

  const expectedSecret = process.env.WEBHOOK_SECRET_KEY;
  const incomingAuthHeader = req.headers.authorization;
  
  if (!incomingAuthHeader || incomingAuthHeader !== `Bearer ${expectedSecret}`) {
    console.warn('Unauthorized webhook request detected.');
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing webhook secret.' });
  }

  // --- 2. Extract Webhook Data ---
  let newsItem;
  try {
    // Supabase sends the data in a 'record' object inside the payload
    newsItem = req.body.record;
    if (!newsItem || !newsItem.title) {
      throw new Error("Invalid Supabase payload structure.");
    }
  } catch (e) {
    return res.status(400).json({ error: 'Bad Request: Invalid payload.', details: e.message });
  }

  console.log(`Processing news item ${newsItem.id}: ${newsItem.title}`);

  // --- 3. The Learning Loop: Fetch Historical Examples ---
  let learningContext = "None available yet. Use a standard expert crypto persona.";
  
  try {
    // Query the 10 best-performing posts from the 'draft_posts' table
    const { data: successfulPosts, error: fetchError } = await supabase
      .from('draft_posts')
      .select('final_approved_post, engagement_score')
      .not('final_approved_post', 'is', null) // Only include posts that were actually reviewed/posted
      .order('engagement_score', { ascending: false })
      .limit(10);
      
    if (fetchError) throw fetchError;
    
    if (successfulPosts.length > 0) {
      // Format the successful posts into a string for the AI's context window
      learningContext = successfulPosts.map((p, index) => 
        `Successful Post ${index + 1} (Score: ${p.engagement_score}): "${p.final_approved_post}"`
      ).join('\n---\n');
      console.log(`Found ${successfulPosts.length} successful posts for learning context`);
    }
  } catch (error) {
    console.error('Error fetching learning context:', error.message);
    // Continue processing with the default context if the database query fails
  }

  // --- 4. Construct the Adaptive Gemini Prompt ---
  const fullPrompt = `
    SYSTEM INSTRUCTION: You are an expert financial analyst focused on crypto and decentralized technology. Your goal is to generate a thoughtful social media post.
    
    LEARNING CONTEXT (EMULATE THIS STYLE):
    Analyze the structure, emoji use, tone, and brevity of the following successful past posts. Your output MUST emulate this effective style.
    ---\n${learningContext}\n---

    CURRENT NEWS TO REACT TO:
    Title: ${newsItem.title}
    Source URL: ${newsItem.url}
    CryptoPanic Sentiment: ${newsItem.sentiment || 'Neutral'}
    
    TASK:
    1. Provide a single, short key Insight (max 15 words) for the user's reference.
    2. Generate one Draft_Tweet (max 240 characters) that is personalized and insightful, directly emulating the style of the successful examples provided in the LEARNING CONTEXT.
    3. Output the result in the required JSON format.
  `;
  
  // --- 5. Call the Gemini API ---
  let geminiResult;
  try {
    console.log('Calling Gemini 2.5 Pro API...');
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-pro", // Using Pro for superior quality
      contents: fullPrompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        temperature: 0.7, // Add some creativity
      },
    });

    geminiResult = JSON.parse(response.text.trim());
    console.log('Gemini API call successful');

  } catch (e) {
    console.error('Gemini API Error:', e.message);
    
    // Handle quota errors specifically
    if (e.message && e.message.includes('429')) {
      console.warn('Gemini API quota exceeded - will retry later');
      return res.status(429).json({ 
        error: 'Gemini API quota exceeded.',
        details: 'Rate limit reached. This webhook will be retried automatically.',
        retry_after: 60
      });
    }
    
    return res.status(500).json({ 
      error: 'AI generation failed.', 
      details: e.message 
    });
  }

  // --- 6. Store Draft Post to Supabase ---
  try {
    console.log('Saving draft to database...');
    console.log('News item ID:', newsItem.id, 'Type:', typeof newsItem.id);
    
    // Ensure news_id is a valid UUID string
    const newsIdToInsert = String(newsItem.id);
    
    const { error: insertError } = await supabase
      .from('draft_posts')
      .insert({
        news_id: newsIdToInsert, // Link to the source news item (UUID)
        gemini_draft: geminiResult.draft_tweet,
        gemini_insight: geminiResult.insight,
        // All other columns default to null/false
      });

    if (insertError) {
      console.error('Insert error details:', JSON.stringify(insertError));
      throw insertError;
    }

    console.log('Draft saved successfully');

    return res.status(200).json({ 
      message: 'AI Draft successfully generated and saved.', 
      draft_id: newsItem.id,
      insight: geminiResult.insight
    });

  } catch (error) {
    console.error('Database insert error:', error.message);
    return res.status(500).json({ 
      error: 'Failed to save draft to Supabase.', 
      details: error.message 
    });
  }
}