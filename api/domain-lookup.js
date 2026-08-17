import { extractDomain, lookupDomainRegistration } from '../lib/rdap.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const domain = extractDomain((req.body || {}).domain);

  if (!domain) {
    return res.status(200).json({ domain: null, available: false, registrationDate: null });
  }

  const result = await lookupDomainRegistration(domain);
  return res.status(200).json(result);
}
