import { BusinessProfileSchema } from '@assistant/contracts';
import { SettingsSchema } from '../messaging/contracts.js';

export const mockProfile = BusinessProfileSchema.parse({
  id: 'sweet-crumbs-demo',
  name: 'Sweet Crumbs Bakery',
  industry: 'Bakery',
  timezone: 'Asia/Kolkata',
  supportPhones: [],
  languages: ['en', 'kn', 'te', 'ta', 'hi'],
  defaultLanguage: 'en',
  tone: 'friendly',
  replyMode: 'DRAFT_ONLY',
  workingHours: {
    description: 'Monday–Saturday, 9:00 AM–7:00 PM (sample)',
    schedule: [],
  },
  knowledgeSource: { type: 'STATIC_JSON', datasetId: 'bakery-demo' },
  thresholds: {
    retrievalMinimumScore: 0.6,
    autoDraftMinimumConfidence: 0.8,
    escalationMaximumUncertainty: 0.2,
  },
  behavior: {
    greetingEnabled: true,
    replyDelayMinSeconds: 0,
    replyDelayMaxSeconds: 5,
    duplicateWindowSeconds: 120,
    perChatCooldownSeconds: 10,
    processFollowupMinutes: 2,
    unknownQueryAction: 'CREATE_TICKET',
  },
  privacy: {},
});
export const defaultSettings = () =>
  SettingsSchema.parse({
    version: 1,
    revision: 0,
    enabled: true,
    activeProfileId: mockProfile.id,
    profiles: [structuredClone(mockProfile)],
  });
