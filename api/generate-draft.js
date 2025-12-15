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
      description: "The hidden second-order effect or meta-narrative (max 10 words).",
    },
    draft_tweet: {
      type: "string",
      description: "Expert commentary, 2-3 sentences (150-250 characters). Must explain the 'so what' and take a stance.",
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
  let learningContext = "None available yet.";
  
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
  
  // Randomize the persona slightly to avoid robotic repetition
  const personas = [
    "A skeptical market veteran who has seen every cycle since 2016.",
    "A deep-tech researcher focused on protocol utility and developer adoption.",
    "A macro-focused investor looking at liquidity flows and market structure."
  ];
  const selectedPersona = personas[Math.floor(Math.random() * personas.length)];

  const fullPrompt = `
    SYSTEM INSTRUCTION: You are ${selectedPersona} You don't just report news; you interpret it through the lens of market structure, narrative cycles, and second-order effects. You are not a corporate bot. You are a conviction-based thought leader.

    YOUR WRITING STYLE:
    - **Authoritative & Opinionated:** Don't hedge. State clearly what this means for the industry.
    - **High Signal:** Use industry-native terminology correctly (e.g., "liquidity fragmentation," "validator economics," "narrative rotation").
    - **Connect the Dots:** Don't just summarize. Mention the hidden implication (e.g., "This acts as a vampire attack on Protocol X" or "This confirms the rotation out of L1s").
    - **Tone:** Sophisticated, "insider" vibe. Not overly formal, but not sloppy.
    - **Format:** 2-3 punchy sentences.
    
    LEARNING CONTEXT (The user likes these past examples):
    ---\n${learningContext}\n---

    CURRENT NEWS TO ANALYZE:
    Title: ${newsItem.title}
    Source URL: ${newsItem.url}
    CryptoPanic Sentiment: ${newsItem.sentiment || 'Neutral'}
    
    TASK:
    1. Insight: The hidden second-order effect of this news that most people miss (max 10 words).
    2. Draft_Tweet: 2-3 sentence commentary (150-280 characters) that follows these rules:
       - **The "So What":** Why does this actually matter? Is it a signal of a new trend or the death of an old one?
       - **Unique Angle:** Take a stance. Avoid generic phrases like "Good news for adoption."
       - **Actionable:** End with what to watch next (e.g., "Watch for flows into X," or "Expect competitors to fork this.").
       - **NO** emojis, **NO** hashtags, **NO** "To the moon" hype.
       
    Output ONLY the JSON with insight and draft_tweet fields.
  `;
  
  // --- 5. Call the Gemini API ---
  let geminiResult;
  try {
    console.log('Calling Gemini 2.5 Pro API...');
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-pro", 
      contents: fullPrompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        temperature: 0.8, // Increased slightly for more "opinion"
      },
    });

    geminiResult = JSON.parse(response.text.trim());
    console.log('Gemini API call successful');

  } catch (e) {
    console.error('Gemini API Error:', e.message);
    
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
    
    // Ensure news_id is a valid UUID string
    const newsIdToInsert = String(newsItem.id);
    
    const { error: insertError } = await supabase
      .from('draft_posts')
      .insert({
        news_id: newsIdToInsert,
        gemini_draft: geminiResult.draft_tweet,
        gemini_insight: geminiResult.insight,
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