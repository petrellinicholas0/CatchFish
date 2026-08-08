export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { system, messages } = req.body || {};

  if (typeof system !== 'string' || !system || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'Missing or invalid system/messages' });
  }

  // Generous sanity cap — well beyond any legitimate bio/email/paper
  // submission (a very long paper is tens of thousands of characters), but
  // bounds otherwise-unbounded input from driving up per-request cost.
  const MAX_REQUEST_CHARS = 300000;
  if (system.length + JSON.stringify(messages).length > MAX_REQUEST_CHARS) {
    return res.status(413).json({ error: 'Submission too large' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        system,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data.error || data);
      return res.status(response.status).json({ error: 'Analysis service error. Please try again.' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('analyze.js error:', err);
    const message = err.name === 'AbortError' ? 'Analysis timed out. Please try again.' : 'Server error. Please try again.';
    return res.status(err.name === 'AbortError' ? 504 : 500).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}
