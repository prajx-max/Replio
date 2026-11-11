import { access, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const workspaces = [
  'packages/contracts',
  'packages/core',
  'packages/knowledge',
  'packages/ui',
  'packages/test-fixtures',
  'apps/api',
];
await Promise.all(
  workspaces.flatMap((workspace) =>
    ['index.js', 'index.d.ts'].map((file) =>
      access(`${workspace}/dist/${file}`),
    ),
  ),
);
// Import emitted JavaScript to catch package export / ESM resolution failures.
const { ReplyModeSchema } = await import('../packages/contracts/dist/index.js');
ReplyModeSchema.parse('DRAFT_ONLY');

const extension = 'apps/extension/dist';
const manifest = JSON.parse(
  await readFile(`${extension}/manifest.json`, 'utf8'),
);
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['storage', 'sidePanel', 'scripting']);
assert.deepEqual(manifest.optional_permissions, ['power']);
assert.deepEqual(manifest.host_permissions, [
  'https://web.whatsapp.com/*',
  'http://127.0.0.1:3000/*',
]);
assert.deepEqual(manifest.content_scripts[0].matches, [
  'https://web.whatsapp.com/*',
]);
assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
assert.equal(manifest.externally_connectable, undefined);
assert.equal(manifest.background.type, 'module');
assert.ok(
  !manifest.content_security_policy.extension_pages.includes('unsafe-eval'),
);
assert.ok(
  !manifest.content_security_policy.extension_pages.includes('unsafe-inline'),
);
await Promise.all(
  [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.side_panel.default_path,
    manifest.options_ui.page,
  ].map((file) => access(`${extension}/${file}`)),
);
for (const file of ['popup.html', 'sidepanel.html', 'options.html']) {
  const html = await readFile(`${extension}/${file}`, 'utf8');
  assert.ok(!/<script[^>]*src=["']https?:/i.test(html));
  assert.ok(!/<script(?![^>]*src=)[^>]*>\s*[^<\s]/i.test(html));
}
const content = await readFile(`${extension}/content.js`, 'utf8');
assert.ok(
  !/^\s*import\s/m.test(content),
  'Content script must be a standalone IIFE',
);
assert.ok(
  !content.includes('Chocolate Truffle Cake'),
  'Business knowledge must not be bundled into the adapter',
);
for (const file of ['service-worker.js', 'content.js', 'manifest.json']) {
  assert.ok(
    !(await readFile(`${extension}/${file}`, 'utf8')).includes(
      '127.0.0.1:4174',
    ),
    'Fixture hosts must not ship in production',
  );
}
await access('apps/api/public/setup.js');
