import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getPrivateKey() {
  return requireEnv('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n');
}

export function getAdminDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: requireEnv('FIREBASE_PROJECT_ID'),
        clientEmail: requireEnv('FIREBASE_CLIENT_EMAIL'),
        privateKey: getPrivateKey(),
      }),
      databaseURL: requireEnv('FIREBASE_DATABASE_URL'),
    });
  }

  return getDatabase();
}
