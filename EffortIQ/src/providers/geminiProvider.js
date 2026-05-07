const axios = require('axios');

/**
 * Google Gemini Provider for EffortIQ
 */
async function geminiEstimate(summary, description, model = 'gemini-1.5-pro', jiraMeta = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const crim_type = jiraMeta?.crim_type ?? 'Unknown';

  if (!apiKey) {
    return {
      ok: false,
      error: 'Missing GEMINI_API_KEY environment variable'
    };
  }

  const prompt = `
You are a Senior IFS Technical Architect.

Analyze this requirement and estimate the technical complexity:

CRIM TYPE: ${crim_type}
SUMMARY: ${summary}
DESCRIPTION: ${description}

Respond with ONLY a JSON object:
{
  "complexity": "Very Simple|Simple|Medium|Complex|Very Complex",
  "estimatedHours": <number>,
  "reasoning": "<brief explanation>"
}
`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 500
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        }
      }
    );

    const content = response.data.candidates[0].content.parts[0].text;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      ok: true,
      hours: parsed.estimatedHours || 0,
      complexity: parsed.complexity,
      reasoning: parsed.reasoning
    };
  } catch (error) {
    return {
      ok: false,
      error: error.response?.data?.error?.message || error.message
    };
  }
}

module.exports = { geminiEstimate };
