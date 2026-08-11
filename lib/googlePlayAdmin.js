import { google } from 'googleapis';

let client;

export function getAndroidPublisher() {
  if (!client) {
    const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      throw new Error('Missing GOOGLE_PLAY_SERVICE_ACCOUNT_JSON environment variable');
    }
    let credentials;
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/androidpublisher']
    });
    client = google.androidpublisher({ version: 'v3', auth });
  }
  return client;
}
