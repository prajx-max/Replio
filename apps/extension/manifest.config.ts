export const manifest = {
  manifest_version: 3,
  name: 'Replio — AI Business Assistant',
  description:
    'Review AI reply suggestions for newly received WhatsApp Web messages.',
  version: '0.7.3',
  minimum_chrome_version: '116',
  permissions: ['storage', 'sidePanel', 'scripting'],
  optional_permissions: ['power'],
  host_permissions: ['https://web.whatsapp.com/*', 'http://127.0.0.1:3000/*'],
  content_scripts: [
    {
      matches: ['https://web.whatsapp.com/*'],
      js: ['content.js'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  background: { service_worker: 'service-worker.js', type: 'module' },
  action: {
    default_popup: 'popup.html',
    default_title: 'Replio — AI Business Assistant',
  },
  side_panel: { default_path: 'sidepanel.html' },
  options_ui: { page: 'options.html', open_in_tab: true },
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'none'; base-uri 'none'; connect-src 'self' http://127.0.0.1:3000; style-src 'self'; img-src 'self' data:; frame-src 'none'",
  },
} as const;
