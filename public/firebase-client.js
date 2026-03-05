import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAnalytics, isSupported } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCuxBczV3S88OTOoBD9OPvspJGXdiGhhmo',
  authDomain: 'downloader-a0f61.firebaseapp.com',
  projectId: 'downloader-a0f61',
  storageBucket: 'downloader-a0f61.firebasestorage.app',
  messagingSenderId: '138833788042',
  appId: '1:138833788042:web:9dea2a94711c4500378173',
  measurementId: 'G-1WP911MJR8'
};

export async function initFirebase() {
  const app = initializeApp(firebaseConfig);

  try {
    if (await isSupported()) {
      getAnalytics(app);
    }
  } catch {
    // Analytics is optional and should not block the app.
  }

  return app;
}
