interface Elements {
  fields: HTMLFieldSetElement;
  configuration: HTMLFormElement;
  message: HTMLParagraphElement;
  profile: HTMLInputElement;
  provider: HTMLSelectElement;
  baseUrl: HTMLInputElement;
  responseFormat: HTMLSelectElement;
  compatibilityFields: HTMLDivElement;
  endpointFields: HTMLDivElement;
  model: HTMLInputElement;
  key: HTMLInputElement;
  remember: HTMLInputElement;
  code: HTMLInputElement;
  pairing: HTMLElement;
  save: HTMLButtonElement;
  copy: HTMLButtonElement;
  test: HTMLButtonElement;
  clear: HTMLButtonElement;
}
function byId<K extends keyof Elements>(id: K): Elements[K] {
  const element = document.getElementById(id);
  if (!element) throw new Error('Setup interface is incomplete');
  return element as Elements[K];
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid backend response.');
  return value as Record<string, unknown>;
}
const form = byId('configuration');
const message = byId('message');
const profile = byId('profile');
const provider = byId('provider');
const baseUrl = byId('baseUrl');
const responseFormat = byId('responseFormat');
const model = byId('model');
const key = byId('key');
let csrf = '';
let generation = 0;
let connectionRevision = 0;
const compatibleProviders = new Set([
  'groq',
  'deepseek',
  'openrouter',
  'mistral',
  'xai',
  'together',
  'custom',
]);
const explanations: Record<string, string> = {
  NOT_CONFIGURED: 'Enter an API key for this provider and API base URL first.',
  INVALID_REQUEST:
    'Check the profile ID, model ID, API key and API base URL. Custom URLs must use public HTTPS on port 443 without credentials, query parameters or /chat/completions.',
  ENDPOINT_REJECTED:
    'This API endpoint is not supported. Use your provider’s public HTTPS base URL on port 443. Localhost, private network addresses and redirects are not allowed.',
  KEY_REJECTED:
    'Your provider rejected the API key. Check the key and its permissions.',
  MODEL_REJECTED:
    'The provider rejected the model or request. Check the model ID and API compatibility.',
  RATE_LIMITED: 'A rate limit was reached. Wait a moment and try again.',
  PROVIDER_UNAVAILABLE: 'The provider could not be reached. Try again shortly.',
  INVALID_OUTPUT:
    'The model did not return the required reply format. Check that the model supports structured replies.',
  UNAUTHORIZED: 'Reload this setup page and try again.',
  CONFIGURATION_SAVE_FAILED:
    'The connection could not be saved on this PC. Check that the backend can write its local environment file. A new connection can use session-only storage; changing or removing an already saved connection requires write access. Your previous connection has not changed.',
};
function announce(text: string, error = false) {
  message.textContent = text;
  message.className = error ? 'error' : 'success';
}
function updateProviderFields() {
  const compatible = compatibleProviders.has(provider.value);
  const custom = provider.value === 'custom';
  byId('compatibilityFields').hidden = !compatible;
  byId('endpointFields').hidden = !custom;
  baseUrl.disabled = !custom;
  baseUrl.required = custom;
  responseFormat.disabled = !compatible;
}
function markUnsaved() {
  connectionRevision++;
  byId('test').disabled = true;
  byId('pairing').hidden = true;
  byId('code').value = '';
  announce('');
}
async function request(path: string, payload: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });
  const result = record((await response.json()) as unknown);
  if (!response.ok)
    throw new Error(
      typeof result.error === 'string'
        ? explanations[result.error] || 'The action could not be completed.'
        : 'The action could not be completed.',
    );
  return result;
}
function renderState(state: Record<string, unknown>) {
  byId('test').disabled = false;
  provider.value =
    typeof state.provider === 'string' ? state.provider : 'openai';
  model.value = typeof state.model === 'string' ? state.model : '';
  baseUrl.value = typeof state.baseUrl === 'string' ? state.baseUrl : '';
  responseFormat.value =
    state.responseFormat === 'text' ? 'text' : 'json_object';
  updateProviderFields();
  byId('code').value =
    typeof state.pairingCode === 'string' ? state.pairingCode : '';
  byId('pairing').hidden = state.configured !== true;
  byId('remember').disabled = state.persistenceAvailable !== true;
  byId('remember').checked =
    state.persistenceAvailable === true &&
    (state.configured !== true || state.remembered === true);
}
async function load() {
  markUnsaved();
  byId('fields').disabled = true;
  const version = ++generation;
  try {
    const response = await fetch(
      `/setup/state?profileId=${encodeURIComponent(profile.value)}`,
      { credentials: 'same-origin', cache: 'no-store' },
    );
    if (!response.ok)
      throw new Error('Reload the setup page to start a new session.');
    const state = record((await response.json()) as unknown);
    if (version !== generation) return;
    if (typeof state.csrf !== 'string')
      throw new Error('Invalid setup session');
    csrf = state.csrf;
    renderState(state);
    byId('fields').disabled = false;
  } catch {
    announce(
      'Setup could not be loaded. Check the business profile ID and reload this page.',
      true,
    );
  }
}
const queryProfile = new URL(location.href).searchParams.get('profileId');
if (queryProfile) profile.value = queryProfile;
for (const field of [provider, model, key, baseUrl, responseFormat])
  field.addEventListener('input', markUnsaved);
provider.addEventListener('change', () => {
  key.value = '';
  baseUrl.value = '';
  model.value = '';
  responseFormat.value = 'json_object';
  updateProviderFields();
});
baseUrl.addEventListener('input', () => {
  key.value = '';
});
profile.addEventListener('change', () => {
  key.value = '';
  announce('');
  void load();
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const save = byId('save');
  save.disabled = true;
  byId('fields').disabled = true;
  markUnsaved();
  try {
    const state = await request('/setup/configure', {
      profileId: profile.value,
      provider: provider.value,
      model: model.value,
      ...(provider.value === 'custom' ? { baseUrl: baseUrl.value.trim() } : {}),
      ...(compatibleProviders.has(provider.value)
        ? { responseFormat: responseFormat.value }
        : {}),
      ...(key.value.trim() ? { apiKey: key.value.trim() } : {}),
      remember: byId('remember').checked,
    });
    renderState(state);
    announce(
      state.remembered === true
        ? 'Model connection saved. It will reconnect after backend restarts. Pair it with your extension below once.'
        : 'Model connection saved for this session only. Pair it with your extension below.',
    );
  } catch (error) {
    announce(error instanceof Error ? error.message : 'Saving failed.', true);
  } finally {
    key.value = '';
    save.disabled = false;
    byId('fields').disabled = false;
  }
});
byId('copy').addEventListener('click', () => {
  void navigator.clipboard.writeText(byId('code').value).then(
    () => announce('Pairing code copied.'),
    () => announce('Select the pairing code and copy it manually.', true),
  );
});
byId('test').addEventListener('click', async () => {
  const button = byId('test');
  const revision = connectionRevision;
  button.disabled = true;
  announce('Testing your provider…');
  try {
    await request('/setup/test', { profileId: profile.value });
    if (revision !== connectionRevision) return;
    announce(
      'Model connection works. You can now enable suggestions in the extension.',
    );
  } catch (error) {
    if (revision === connectionRevision)
      announce(
        error instanceof Error ? error.message : 'The test failed.',
        true,
      );
  } finally {
    if (revision === connectionRevision) button.disabled = false;
  }
});
byId('clear').addEventListener('click', async () => {
  if (
    !confirm('Remove this backend key and revoke this business’s pairing code?')
  )
    return;
  try {
    await request('/setup/clear', { profileId: profile.value });
    await load();
    announce('Key removed and pairing revoked.');
  } catch {
    announce('The connection could not be removed. Try again.', true);
  }
});
void load();
