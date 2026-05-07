const axios = require('axios');

/**
 * Local Provider for EffortIQ
 * For on-premises or custom local estimation services
 */
async function localEstimate(summary, description, model = null, jiraMeta = {}) {
  const endpoint = process.env.LOCAL_ESTIMATE_ENDPOINT || 'http://localhost:8080/estimate';
  const crim_type = jiraMeta?.crim_type ?? 'Unknown';

  if (!endpoint) {
    return {
      ok: false,
      error: 'Missing LOCAL_ESTIMATE_ENDPOINT environment variable'
    };
  }

  try {
    const response = await axios.post(
      endpoint,
      {
        summary: summary,
        description: description,
        crim_type: crim_type
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return {
      ok: true,
      hours: response.data.estimatedHours || 0,
      complexity: response.data.complexity,
      reasoning: response.data.reasoning
    };
  } catch (error) {
    return {
      ok: false,
      error: error.response?.data?.error || error.message
    };
  }
}

module.exports = { localEstimate };
