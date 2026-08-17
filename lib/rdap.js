// Shared RDAP (domain registration lookup) helper -- originally lived only
// inside api/domain-lookup.js (used by Email Check's sender-domain-age
// check). Extracted here so api/evidence-packet.js can reuse the exact
// same lookup logic for its per-page domain-age data without duplicating
// it; api/domain-lookup.js now just calls this.

export function extractDomain(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;

  s = s.replace(/^[a-z]+:\/\//, '');

  const atIdx = s.lastIndexOf('@');
  if (atIdx !== -1) s = s.slice(atIdx + 1);

  s = s.split(/[/?#]/)[0];
  s = s.split(':')[0];

  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

export async function lookupDomainRegistration(domain, { timeoutMs = 5000 } = {}) {
  if (!domain) {
    return { domain: null, available: false, registrationDate: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/rdap+json' }
    });

    if (!resp.ok) {
      return { domain, available: false, registrationDate: null };
    }

    const data = await resp.json();
    const registrationEvent = (data.events || []).find((e) => e.eventAction === 'registration');
    const registrationDate = registrationEvent ? registrationEvent.eventDate : null;

    return {
      domain,
      available: !!registrationDate,
      registrationDate
    };
  } catch (err) {
    return { domain, available: false, registrationDate: null };
  } finally {
    clearTimeout(timeout);
  }
}
