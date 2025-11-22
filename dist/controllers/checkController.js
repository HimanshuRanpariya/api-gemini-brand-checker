const axios = require("axios");
const {
  extractTextFromApiResponse,
  splitIntoItems,
  findBrandPositions,
} = require("../utils/brandUtils");

const TEMPERATURE = parseFloat(process.env.GEMINI_TEMPERATURE || "0.2");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
// Use a single configured model (GEMINI_MODEL). If not set, fall back to a reasonable default for Google Gemini.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

exports.check = async (req, res) => {
  const { prompt, brand } = req.body || {};
  if (!prompt || !brand)
    return res.status(400).json({ error: "Missing prompt or brand" });

  const cannedFallback = `No clear brand mentions found.`;

  const usedModel = MODEL;

  try {
    let text = "";
      if (GEMINI_API_KEY) {
      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: TEMPERATURE, maxOutputTokens: 2048 },
      };
      const headers = { "Content-Type": "application/json" };

      // Use only the configured MODEL for a single API call
      const tryUrl = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      let apiResp = null;
      try {
        apiResp = await axios.post(tryUrl, payload, { headers, timeout: 20000 });
      } catch (e) {
        // Propagate error to outer catch so we handle it uniformly
        throw e;
      }

      try {
      } catch (e) {
      }

      if (apiResp && apiResp.data) {
        const d = apiResp.data;
        if (d.candidates && d.candidates.length) {
          const candidate = d.candidates[0];
          if (
            candidate.content &&
            candidate.content.parts &&
            candidate.content.parts.length
          ) {
            text = candidate.content.parts
              .filter((p) => p.text)
              .map((p) => p.text)
              .join("\n");
          } else if (candidate.text) {
            text = candidate.text;
          } else if (candidate.output) {
            text = candidate.output;
          } else if (candidate.content) {
            if (typeof candidate.content === "string") text = candidate.content;
            else if (candidate.content.text) text = candidate.content.text;
            else {
              text = JSON.stringify(candidate.content);
            }
          } else {
            text =
              candidate.text || candidate.output || JSON.stringify(candidate);
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
      text = cannedFallback;
    }

    const items = splitIntoItems(text);
    const positions = findBrandPositions(items, brand);
    const mentioned = positions.length > 0 ? "Yes" : "No";
    const position = positions.length > 0 ? positions[0] : null;

    return res.json({
      prompt,
      brand,
      mentioned,
      positions,
      position,
      raw_text: text,
      used_model: usedModel || null,
    });
  } catch (err) {
    if (err && err.response && err.response.data) {
      try {
        console.error(
          "API error response:",
          JSON.stringify(err.response.data, null, 2)
        );
      } catch (e) {
        console.error(
          "API error response (non-serializable):",
          err.response.data
        );
      }
    }
    console.error(
      "API error:",
      err && err.stack ? err.stack : (err && err.message) || err
    );
    const providerDetail =
      err && err.response && err.response.data ? err.response.data : undefined;
    const providerStatus =
      err && err.response && err.response.status
        ? err.response.status
        : undefined;

    let providerReason;
    try {
      if (
        providerDetail &&
        providerDetail.error &&
        Array.isArray(providerDetail.error.details)
      ) {
        const d = providerDetail.error.details.find(
          (x) => x.reason || (x["@type"] && x.reason)
        );
        providerReason = d && d.reason;
      }
      if (
        !providerReason &&
        providerDetail &&
        providerDetail.error &&
        providerDetail.error.message
      ) {
        const m = (providerDetail.error.message || "").toLowerCase();
        if (
          m.includes("api key") ||
          m.includes("api_key") ||
          m.includes("api-key")
        )
          providerReason = "API_KEY_INVALID";
      }
    } catch (e) {}

    if (providerReason === "API_KEY_INVALID") {
      const errorMsg =
        providerDetail && providerDetail.error
          ? providerDetail.error.message
          : "API key expired or invalid";
      return res.status(401).json({
        error: "Invalid API key",
        message:
          "The configured GEMINI_API_KEY is invalid or expired. Renew or replace the API key.",
        prompt,
        brand,
        mentioned: "No",
        positions: [],
        position: null,
        raw_text: `❌ API Key Error: ${errorMsg}\n\nStatus: ${
          providerStatus || "N/A"
        }\n\nPlease update your GEMINI_API_KEY in the server environment variables.\n\nGet a new key at: https://aistudio.google.com/apikey`,
        _error: "API key invalid or expired",
        providerStatus,
        providerDetail,
        used_model: usedModel || null,
      });
    }

    const errorMsg =
      providerDetail && providerDetail.error
        ? `API Error: ${providerDetail.error.message || "Unknown error"}`
        : `API Error: ${err && err.message ? err.message : "Unknown error"}`;
    let troubleshooting = "";
    if (providerStatus === 404) {
      troubleshooting =
        `\n\n🔧 Troubleshooting:\n` +
        `1. Verify your API key has access to Gemini models\n` +
        `2. Enable "Generative Language API" in Google Cloud Console\n` +
        `3. Check that your API key is for Gemini, not another service\n` +
        `4. Visit: https://aistudio.google.com/apikey to create/verify your key`;
    }

    return res.status(providerStatus || 500).json({
      error: errorMsg,
      message: "API call failed - returning canned response",
      prompt,
      brand,
      mentioned: "No",
      positions: [],
      position: null,
      raw_text: `${cannedFallback}\n\n${errorMsg}\nStatus: ${
        providerStatus || "N/A"
      }${troubleshooting}`,
      _error: "API error - returning canned response",
      providerStatus,
      providerDetail,
      used_model: usedModel || null,
    });
  }
};
