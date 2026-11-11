import { useCallback, useEffect, useRef, useState } from 'react';
import { assistantClient } from '../messaging/client.js';
import type { AssistantClient } from '../messaging/client.js';
import type { ShellRequest, ShellState } from '../messaging/contracts.js';

export function useAssistant(client: AssistantClient = assistantClient) {
  const [state, setState] = useState<ShellState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const next = await client.request({ version: 1, type: 'GET_STATE' });
      if (version === generation.current) setState(next);
    } catch (failure) {
      if (version === generation.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'The extension is unavailable.',
        );
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const unsubscribe = client.subscribe(() => {
      void refresh();
    });
    return () => {
      ++generation.current;
      unsubscribe();
    };
  }, [client, refresh]);
  async function act(request: ShellRequest): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      const next = await client.request(request);
      ++generation.current;
      setState(next);
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Please try again.',
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { state, error, busy, act, refresh };
}
