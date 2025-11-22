require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());
// Simple CORS middleware so the frontend (localhost:3000) can call this API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    return res.sendStatus(200);
  }
  next();
});

// Fixed model and temperature (least expensive model chosen here)
const MODEL = process.env.GEMINI_MODEL || 'gpt-4o-mini';
const TEMPERATURE = parseFloat(process.env.GEMINI_TEMPERATURE || '0.2');

// GEMINI_API_HOST and GEMINI_API_KEY must be set as environment variables for real API calls
const GEMINI_API_HOST = process.env.GEMINI_API_HOST || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// If user only has a Google "Gemini"/Generative API key, we can call the Generative API
// Default to gemini-2.5-flash (newest, fastest) - will auto-detect available models if this doesn't work
// Valid models: gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash, etc. (without "models/" prefix in URL)
const GOOGLE_MODEL = process.env.GEMINI_MODEL_GOOGLE || 'gemini-2.5-flash';

function levenshtein(a, b) {
  if (!a) return b.length;
  if (!b) return a.length;
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => new Array(a.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const substitutionCost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + substitutionCost
      );
    }
  }
  return matrix[b.length][a.length];
}

function extractTextFromApiResponse(resp) {
  // Try common shapes, otherwise fall back to raw string
  try {
    if (!resp) return '';
    // Axios resp.data
    const data = resp.data || resp;
    // OpenAI-like: data.output_text or data.output?.[0]?.content
    if (typeof data === 'string') return data;
    if (data.output_text) return data.output_text;
    if (data.output && Array.isArray(data.output) && data.output.length) {
      const o = data.output[0];
      if (typeof o === 'string') return o;
      if (o.content) {
        if (typeof o.content === 'string') return o.content;
        if (Array.isArray(o.content)) {
          // join text parts
          return o.content.map(c => (c.text || c)).join('\n');
        }
      }
    }
    if (data.choices && data.choices.length) {
      const ch = data.choices[0];
      if (ch.text) return ch.text;
      if (ch.message && ch.message.content) return ch.message.content;
    }
    // fallback: stringify
    return JSON.stringify(data);
  } catch (e) {
    return '';
  }
}

function splitIntoItems(text) {
  if (!text) return [];
  // Split by newlines first; if too few items, split by commas
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1) {
    lines = text.split(/,|;|\n/).map(l => l.trim()).filter(Boolean);
  }
  return lines;
}

function findBrandPositions(items, brand) {
  const brandLower = brand.toLowerCase();
  const positions = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemLower = item.toLowerCase();
    // Exact whole word match
    const regex = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
    if (regex.test(item)) {
      positions.push(i + 1);
      continue;
    }
    // Fuzzy match: token-level levenshtein <= 2 or substring
    if (itemLower.includes(brandLower)) {
      positions.push(i + 1);
      continue;
    }
    const tokens = item.split(/\s+/).map(t => t.replace(/[.,()]/g, ''));
    for (const t of tokens) {
      if (!t) continue;
      const dist = levenshtein(t.toLowerCase(), brandLower.toLowerCase());
      if (dist <= 2) {
        positions.push(i + 1);
        break;
      }
    }
  }
  return positions;
}

app.post('/api/check', async (req, res) => {
  const { prompt, brand } = req.body || {};
  if (!prompt || !brand) {
    return res.status(400).json({ error: 'Missing prompt or brand' });
  }

  // Prepare a canned fallback answer to return on API failure
  const cannedFallback = `No clear brand mentions found.`;

  try {
    let text = '';
    if (GEMINI_API_HOST && GEMINI_API_KEY) {
      // If the configured host looks like Google's Generative Language API, call the
      // correct `:generateText` path (the host in .env may be just the base domain).
      const isGoogleHost = GEMINI_API_HOST.includes('generativelanguage.googleapis.com') || GEMINI_API_HOST.includes('googleapis.com');
      if (isGoogleHost) {
        // Use Gemini API format: generateContent endpoint with v1 API
        // URL format: /v1/models/{model}:generateContent
        // Model name should be just the model name (e.g., "gemini-pro") not "models/gemini-pro"
        let modelName = GOOGLE_MODEL.replace(/^models\//, ''); // Remove "models/" prefix if present
        // Try different model names if the default doesn't work
        const googleV1 = `${GEMINI_API_HOST}/v1/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
        
        // Gemini API uses contents array format
        const payload = {
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            temperature: TEMPERATURE,
            maxOutputTokens: 2048
          }
        };
        const headers = { 'Content-Type': 'application/json' };
        let apiResp;
        // First, try to get list of available models
        let availableModels = [];
        try {
          const listUrl = `${GEMINI_API_HOST}/v1/models?key=${GEMINI_API_KEY}`;
          const listResp = await axios.get(listUrl, { timeout: 10000 });
          if (listResp.data && listResp.data.models) {
            availableModels = listResp.data.models
              .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
              .map(m => m.name.replace('models/', ''));
            console.log('Available models:', availableModels);
          }
        } catch (listErr) {
          console.log('Could not fetch model list, will try default models');
        }
        
        // Try multiple models in order of preference
        // Use available models if we got them, otherwise use defaults (newer models first)
        const defaultModels = [modelName, 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
        const modelsToTry = availableModels.length > 0 ? availableModels : defaultModels;
        let lastError = null;
        
        for (const tryModel of modelsToTry) {
          if (tryModel === modelName && modelsToTry.indexOf(tryModel) > 0) continue; // Skip if already tried
          const tryUrl = `${GEMINI_API_HOST}/v1/models/${tryModel}:generateContent?key=${GEMINI_API_KEY}`;
          try {
            console.log(`Trying model: ${tryModel}`);
            apiResp = await axios.post(tryUrl, payload, { headers, timeout: 20000 });
            console.log(`Success with model: ${tryModel}`);
            break; // Success, exit loop
          } catch (e) {
            lastError = e;
            if (e && e.response && e.response.status === 404) {
              console.log(`Model ${tryModel} not found, trying next...`);
              continue; // Try next model
            } else {
              throw e; // Other errors, throw immediately
            }
          }
        }
        
        if (!apiResp) {
          // All models failed
          if (lastError) throw lastError;
          throw new Error('All model attempts failed');
        }
        try { 
          console.log('Provider response (google-host):', JSON.stringify(apiResp.data, null, 2)); 
          if (apiResp.data?.candidates?.[0]) {
            console.log('First candidate:', JSON.stringify(apiResp.data.candidates[0], null, 2));
            console.log('Candidate content:', JSON.stringify(apiResp.data.candidates[0].content, null, 2));
            console.log('Candidate content parts:', JSON.stringify(apiResp.data.candidates[0].content?.parts, null, 2));
          }
        } catch (e) { console.log('Provider response (google-host) logged'); }
        if (apiResp && apiResp.data) {
          const d = apiResp.data;
          // Gemini API response format: candidates[0].content.parts[0].text
          if (d.candidates && d.candidates.length) {
            const candidate = d.candidates[0];
            console.log('Processing candidate, content type:', typeof candidate.content, 'has parts:', !!candidate.content?.parts);
            
            // Check if content has parts array with text
            if (candidate.content && candidate.content.parts && Array.isArray(candidate.content.parts) && candidate.content.parts.length > 0) {
              // Standard Gemini format: content.parts[].text
              const textParts = candidate.content.parts
                .filter(p => p && p.text) // Only get parts with text
                .map(p => p.text);
              if (textParts.length > 0) {
                text = textParts.join('\n');
                console.log('Extracted text from parts:', text.substring(0, 100));
              } else {
                console.log('Parts array exists but no text found');
                // Maybe parts are in a different format
                text = candidate.content.parts.map(p => JSON.stringify(p)).join('\n');
              }
            } else if (candidate.text) {
              // Alternative format: candidate.text
              text = candidate.text;
              console.log('Using candidate.text');
            } else if (candidate.output) {
              // Another alternative: candidate.output
              text = candidate.output;
              console.log('Using candidate.output');
            } else if (candidate.content) {
              // If content exists but no parts, check all possible fields
              if (typeof candidate.content === 'string') {
                text = candidate.content;
                console.log('Content is string');
              } else if (candidate.content.text) {
                text = candidate.content.text;
                console.log('Using content.text');
              } else if (candidate.content.role) {
                // Content only has role, might be incomplete response
                console.log('Warning: Content only has role, checking for finishReason or other fields');
                // Check if there's a finishReason that indicates why no text
                if (candidate.finishReason) {
                  text = `Response incomplete. Finish reason: ${candidate.finishReason}. Content: ${JSON.stringify(candidate.content)}`;
                } else {
                  text = JSON.stringify(candidate.content);
                }
              } else {
                // Last resort: stringify the content
                console.log('Warning: Unexpected content format:', JSON.stringify(candidate.content));
                text = JSON.stringify(candidate.content);
              }
            } else {
              // Fallback: try to extract any text from candidate
              console.log('No content found, checking candidate directly');
              text = candidate.text || candidate.output || JSON.stringify(candidate);
            }
          } else if (d.result && d.result.output) {
            text = d.result.output;
          } else {
            text = extractTextFromApiResponse(apiResp);
          }
        } else {
          text = cannedFallback;
        }
      } else {
        // Attempt to call configured Gemini-like endpoint (OpenAI Responses style)
        const payload = {
          model: MODEL,
          input: prompt,
          temperature: TEMPERATURE
        };
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GEMINI_API_KEY}`
        };
        const apiResp = await axios.post(GEMINI_API_HOST, payload, { headers, timeout: 20000 });
        // Log provider response for debugging (do not log secrets)
        try { console.log('Provider response (host):', JSON.stringify(apiResp.data, null, 2)); } catch (e) { console.log('Provider response (host) logged'); }
        text = extractTextFromApiResponse(apiResp);
      }
    } else if (GEMINI_API_KEY) {
      // No custom host provided but a Gemini API key exists — attempt Google Gemini API
      // Use generateContent endpoint with Gemini API format
      // Model name should be without "models/" prefix in the URL
      const modelName = GOOGLE_MODEL.replace(/^models\//, ''); // Remove "models/" prefix if present
      const googleUrl = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
      const payload = {
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
          generationConfig: {
            temperature: TEMPERATURE,
            maxOutputTokens: 2048
          }
      };
      const headers = { 'Content-Type': 'application/json' };
      // First, try to get list of available models
      let availableModels = [];
      try {
        const listUrl = `https://generativelanguage.googleapis.com/v1/models?key=${GEMINI_API_KEY}`;
        const listResp = await axios.get(listUrl, { timeout: 10000 });
        if (listResp.data && listResp.data.models) {
          availableModels = listResp.data.models
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace('models/', ''));
          console.log('Available models:', availableModels);
        }
      } catch (listErr) {
        console.log('Could not fetch model list, will try default models');
      }
      
      // Try multiple models in order of preference
      // Use available models if we got them, otherwise use defaults (newer models first)
      const defaultModels = [modelName, 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
      const modelsToTry = availableModels.length > 0 ? availableModels : defaultModels;
      let apiResp = null;
      let lastError = null;
      
      for (const tryModel of modelsToTry) {
        if (tryModel === modelName && modelsToTry.indexOf(tryModel) > 0) continue; // Skip if already tried
        const tryUrl = `https://generativelanguage.googleapis.com/v1/models/${tryModel}:generateContent?key=${GEMINI_API_KEY}`;
        try {
          console.log(`Trying model: ${tryModel}`);
          apiResp = await axios.post(tryUrl, payload, { headers, timeout: 20000 });
          console.log(`Success with model: ${tryModel}`);
          break; // Success, exit loop
        } catch (e) {
          lastError = e;
          if (e && e.response && e.response.status === 404) {
            console.log(`Model ${tryModel} not found, trying next...`);
            continue; // Try next model
          } else {
            throw e; // Other errors, throw immediately
          }
        }
      }
      
      if (!apiResp) {
        // All models failed
        if (lastError) throw lastError;
        throw new Error('All model attempts failed');
      }
      // Log Google Gemini API response for debugging
      try { console.log('Provider response (google):', JSON.stringify(apiResp.data, null, 2)); } catch (e) { console.log('Provider response (google) logged'); }
      // Try to extract Gemini API response format: candidates[0].content.parts[0].text
      if (apiResp && apiResp.data) {
        const d = apiResp.data;
        if (d.candidates && d.candidates.length) {
          const candidate = d.candidates[0];
          if (candidate.content && candidate.content.parts && candidate.content.parts.length) {
            // Standard Gemini format: content.parts[].text
            text = candidate.content.parts
              .filter(p => p.text) // Only get parts with text
              .map(p => p.text)
              .join('\n');
          } else if (candidate.text) {
            // Alternative format: candidate.text
            text = candidate.text;
          } else if (candidate.output) {
            // Another alternative: candidate.output
            text = candidate.output;
          } else if (candidate.content) {
            // If content exists but no parts, try to extract
            if (typeof candidate.content === 'string') {
              text = candidate.content;
            } else if (candidate.content.text) {
              text = candidate.content.text;
            } else {
              // Last resort: stringify the content
              console.log('Warning: Unexpected content format:', JSON.stringify(candidate.content));
              text = JSON.stringify(candidate.content);
            }
          } else {
            // Fallback: try to extract any text from candidate
            text = candidate.text || candidate.output || JSON.stringify(candidate);
          }
        } else if (d.result && d.result.output) {
          text = d.result.output;
        } else {
          text = extractTextFromApiResponse(apiResp);
        }
      } else {
        text = cannedFallback;
      }
    } else {
      // No API configured: return a simple canned reply so app still works
      text = cannedFallback;
    }

    const items = splitIntoItems(text);
    console.log(text);
    const positions = findBrandPositions(items, brand);
    const mentioned = positions.length > 0 ? 'Yes' : 'No';
    const position = positions.length > 0 ? positions[0] : null;

    return res.json({
      prompt,
      brand,
      mentioned,
      positions,
      position,
      raw_text: text
    });
  } catch (err) {
    // Log useful error details (stack, message, and provider response when available)
    if (err && err.response && err.response.data) {
      try {
        console.error('API error response:', JSON.stringify(err.response.data, null, 2));
      } catch (e) {
        console.error('API error response (non-serializable):', err.response.data);
      }
    }
    console.error('API error:', err && err.stack ? err.stack : (err && err.message) || err);
    // If the provider reports an invalid/expired API key, return a clear 401
    const providerDetail = err && err.response && err.response.data ? err.response.data : undefined;
    const providerStatus = err && err.response && err.response.status ? err.response.status : undefined;
    // Try to detect Google's API_KEY_INVALID indicator
    let providerReason;
    try {
      if (providerDetail && providerDetail.error && Array.isArray(providerDetail.error.details)) {
        const d = providerDetail.error.details.find(x => x.reason || (x['@type'] && x.reason));
        providerReason = d && d.reason;
      }
      if (!providerReason && providerDetail && providerDetail.error && providerDetail.error.message) {
        const m = (providerDetail.error.message || '').toLowerCase();
        if (m.includes('api key') || m.includes('api_key') || m.includes('api-key')) providerReason = 'API_KEY_INVALID';
      }
    } catch (e) {}

    if (providerReason === 'API_KEY_INVALID') {
      const errorMsg = providerDetail && providerDetail.error ? 
        providerDetail.error.message : 'API key expired or invalid';
      return res.status(401).json({
        error: 'Invalid API key',
        message: 'The configured GEMINI_API_KEY is invalid or expired. Renew or replace the API key.',
        prompt,
        brand,
        mentioned: 'No',
        positions: [],
        position: null,
        raw_text: `❌ API Key Error: ${errorMsg}\n\nStatus: ${providerStatus || 'N/A'}\n\nPlease update your GEMINI_API_KEY in the server environment variables.\n\nGet a new key at: https://aistudio.google.com/apikey`,
        _error: 'API key invalid or expired',
        providerStatus,
        providerDetail
      });
    }

    // On other API errors, return canned answer so app still works
    // Include error details in raw_text so user can see what went wrong
    const errorMsg = providerDetail && providerDetail.error ? 
      `API Error: ${providerDetail.error.message || 'Unknown error'}` : 
      `API Error: ${err && err.message ? err.message : 'Unknown error'}`;
    
    // Add helpful troubleshooting info for 404 errors
    let troubleshooting = '';
    if (providerStatus === 404) {
      troubleshooting = `\n\n🔧 Troubleshooting:\n` +
        `1. Verify your API key has access to Gemini models\n` +
        `2. Enable "Generative Language API" in Google Cloud Console\n` +
        `3. Check that your API key is for Gemini, not another service\n` +
        `4. Visit: https://aistudio.google.com/apikey to create/verify your key`;
    }
    
    return res.json({
      prompt,
      brand,
      mentioned: 'No',
      positions: [],
      position: null,
      raw_text: `${cannedFallback}\n\n${errorMsg}\nStatus: ${providerStatus || 'N/A'}${troubleshooting}`,
      _error: 'API error - returning canned response',
      providerStatus,
      providerDetail
    });
  }
});

// Endpoint to list available models
app.get('/api/list-models', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(400).json({ error: 'No GEMINI_API_KEY configured on server' });
  
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1/models?key=${GEMINI_API_KEY}`;
    const apiResp = await axios.get(listUrl, { timeout: 20000 });
    return res.json({ models: apiResp.data });
  } catch (err) {
    const providerDetail = err && err.response && err.response.data ? err.response.data : undefined;
    return res.status(500).json({ 
      error: 'Failed to list models', 
      detail: err.message,
      providerDetail 
    });
  }
});

// Simple endpoint to ping the configured provider and return the raw provider response.
// Useful for debugging provider credentials and response shapes.
app.get('/api/ping-provider', async (req, res) => {
  const samplePrompt = req.query.prompt || 'Say hello and list 3 CRM names';
  if (!GEMINI_API_KEY) return res.status(400).json({ error: 'No GEMINI_API_KEY configured on server' });

  try {
    if (GEMINI_API_HOST) {
      const isGoogleHost = GEMINI_API_HOST.includes('generativelanguage.googleapis.com') || GEMINI_API_HOST.includes('googleapis.com');
      if (isGoogleHost) {
        const modelName = GOOGLE_MODEL.replace(/^models\//, '');
        const googleUrl = `${GEMINI_API_HOST}/v1/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
        const payload = {
          contents: [{
            parts: [{ text: samplePrompt }]
          }],
          generationConfig: {
            temperature: TEMPERATURE,
            maxOutputTokens: 512
          }
        };
        const headers = { 'Content-Type': 'application/json' };
        const apiResp = await axios.post(googleUrl, payload, { headers, timeout: 20000 });
        try { console.log('Ping provider response (google-host):', JSON.stringify(apiResp.data, null, 2)); } catch (e) { console.log('Ping provider response logged'); }
        return res.json({ provider: 'google', raw: apiResp.data });
      }

      const payload = { model: MODEL, input: samplePrompt, temperature: TEMPERATURE };
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GEMINI_API_KEY}` };
      const apiResp = await axios.post(GEMINI_API_HOST, payload, { headers, timeout: 20000 });
      try { console.log('Ping provider response (host):', JSON.stringify(apiResp.data, null, 2)); } catch (e) { console.log('Ping provider response logged'); }
      return res.json({ provider: 'host', raw: apiResp.data });
    }

    // Google Gemini API fallback (no GEMINI_API_HOST provided)
    const modelName = GOOGLE_MODEL.replace(/^models\//, '');
    const googleUrl = `https://generativelanguage.googleapis.com/v1/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [{
        parts: [{ text: samplePrompt }]
      }],
      generationConfig: {
        temperature: TEMPERATURE,
        maxOutputTokens: 256
      }
    };
    const headers = { 'Content-Type': 'application/json' };
    const apiResp = await axios.post(googleUrl, payload, { headers, timeout: 20000 });
    try { console.log('Ping provider response (google):', JSON.stringify(apiResp.data, null, 2)); } catch (e) { console.log('Ping provider response logged'); }
    return res.json({ provider: 'google', raw: apiResp.data });
  } catch (err) {
    if (err && err.response && err.response.data) {
      try {
        console.error('Ping provider response error:', JSON.stringify(err.response.data, null, 2));
      } catch (e) {
        console.error('Ping provider response error (non-serializable):', err.response.data);
      }
    }
    console.error('Ping provider error:', err && err.stack ? err.stack : (err && err.message) || err);
    // Return richer error details to the client to aid debugging (avoid leaking secrets)
    const providerDetail = err && err.response && err.response.data ? err.response.data : undefined;
    const providerStatus = err && err.response && err.response.status ? err.response.status : undefined;
    const tried = err && err._tried ? err._tried : undefined;

    // Detect Google's API key invalid/expired case and return 401 with a clear message
    let providerReason;
    try {
      if (providerDetail && providerDetail.error && Array.isArray(providerDetail.error.details)) {
        const d = providerDetail.error.details.find(x => x.reason || (x['@type'] && x.reason));
        providerReason = d && d.reason;
      }
      if (!providerReason && providerDetail && providerDetail.error && providerDetail.error.message) {
        const m = (providerDetail.error.message || '').toLowerCase();
        if (m.includes('api key') || m.includes('api_key') || m.includes('api-key')) providerReason = 'API_KEY_INVALID';
      }
    } catch (e) {}

    if (providerReason === 'API_KEY_INVALID') {
      return res.status(401).json({ error: 'Invalid API key', message: 'The configured GEMINI_API_KEY is invalid or expired. Renew or replace the API key.', providerStatus, providerDetail, tried });
    }

    return res.status(500).json({ error: 'Provider call failed', detail: err && err.message, providerStatus, providerDetail, tried });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
