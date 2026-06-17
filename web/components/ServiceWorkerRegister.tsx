'use client';

import { useEffect } from 'react';

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      // Register Service Worker only on localhost or HTTPS
      const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const isHttps = window.location.protocol === 'https:';

      if (isLocalhost || isHttps) {
        navigator.serviceWorker
          .register('/sw.js')
          .then((reg) => {
            console.log('[SW Cache] Service Worker registered successfully with scope:', reg.scope);
          })
          .catch((err) => {
            console.error('[SW Cache] Service Worker registration failed:', err);
          });
      }
    }
  }, []);

  return null;
}
