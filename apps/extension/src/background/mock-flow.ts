import { ExtensionEventSchema } from '@assistant/contracts';
import { DemoRunSchema } from '../messaging/contracts.js';
import type { DemoRun } from '../messaging/contracts.js';

export async function createMockFlow(profileId: string): Promise<DemoRun> {
  // Synthetic identity only; real chat hashing belongs to the adapter milestone.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`fictional:${profileId}`),
  );
  const chatKey = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const event = ExtensionEventSchema.parse({
    version: 1,
    type: 'ASSISTANT_DECISION_READY',
    payload: {
      profileId,
      chatKey,
      eventKey: `sample-${crypto.randomUUID()}`,
      decision: {
        kind: 'ANSWER',
        confidence: 1,
        importance: 'NORMAL',
        sendPolicy: 'DRAFT',
        reply:
          'Our Chocolate Truffle Cake is ₹650 for 500 grams. An eggless option is available. Please order at least 6 hours in advance.',
        citations: [
          {
            profileId,
            recordId: 'sample-truffle-cake',
            title: 'Chocolate Truffle Cake · sample record',
          },
        ],
      },
    },
  });
  return DemoRunSchema.parse({
    profileId,
    customerMessage: 'What is the price of your Chocolate Truffle Cake?',
    language: 'en',
    intent: 'PRICE',
    event,
  });
}
