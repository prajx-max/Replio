import { BusinessProfileSchema } from '@assistant/contracts';

export function bakeryProfile() {
  return BusinessProfileSchema.parse({
    id: 'sweet-crumbs-demo',
    name: 'Sweet Crumbs Bakery',
    industry: 'Bakery',
    timezone: 'Asia/Kolkata',
    supportPhones: [],
    languages: ['en', 'kn', 'te', 'ta', 'hi'],
    defaultLanguage: 'en',
    tone: 'friendly',
    replyMode: 'DRAFT_ONLY',
    replyInstructions:
      'Keep replies polite and concise. Use the customer’s language. Ask for human help when information is missing.',
    businessInformation:
      'Chocolate Truffle Cake: ₹650 for 500 grams. Eggless option available. Minimum 6 hours advance notice. This is fictional fixture data.',
    workingHours: { description: 'Fictional example hours', schedule: [] },
    knowledgeSource: { type: 'STATIC_JSON', datasetId: 'bakery-demo' },
    thresholds: {
      retrievalMinimumScore: 0.6,
      autoDraftMinimumConfidence: 0.8,
      escalationMaximumUncertainty: 0.2,
    },
    behavior: {
      greetingEnabled: true,
      replyDelayMinSeconds: 0,
      replyDelayMaxSeconds: 0,
      duplicateWindowSeconds: 120,
      perChatCooldownSeconds: 0,
      processFollowupMinutes: 2,
      unknownQueryAction: 'CREATE_TICKET',
    },
    privacy: {},
  });
}
