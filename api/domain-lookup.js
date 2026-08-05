function extractDomain(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;

  s = s.replace(/^[a-z]+:\/\//, '');

  const atIdx = s.lastIndexOf('@');
  if (atIdx !== -1) s = s.slice(atIdx + 1);

  s = s.split(/[\/?#]/)[0];
  s = s.split(':')[0];

  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const domain = extractDomain((req.body || {}).domain);

  if (!domain) {
    return res.status(200).json({ domain: null, available: false, registrationDate: null });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/rdap+json' }
    });

    if (!resp.ok) {
      return res.status(200).json({ domain, available: false, registrationDate: null });
    }

    const data = await resp.json();
    const registrationEvent = (data.events || []).find(e => e.eventAction === 'registration');
    const registrationDate = registrationEvent ? registrationEvent.eventDate : null;

    return res.status(200).json({
      domain,
      available: !!registrationDate,
      registrationDate
    });
  } catch (err) {
    return res.status(200).json({ domain, available: false, registrationDate: null });
  } finally {
    clearTimeout(timeout);
  }
}
