import { describe, expect, it } from 'vitest';
import {
  detectCallbackRequest,
  detectHandoffPromise,
  handoffAcknowledgement,
} from '../src/reply/handoff.js';
import { validateGroundedReply } from '../src/reply/policy.js';
import { bakeryProfile } from '../../test-fixtures/src/profiles.js';

describe('customer requests for human contact', () => {
  it.each([
    'Please call me',
    'Could your team contact me?',
    'Can I get a callback please?',
    'I would like a call about my order',
    'I need a callback',
    'Call-back please.',
    'callback',
    'Please call back',
    'Please arrange a callback',
    'Please connect me to a human',
    'Can I speak to your manager?',
    'I want to talk with your team.',
    'I need human assistance',
    'Support agent please',
    'Please let me speak to an agent',
    'No email, please call me.',
    'Don’t call me; connect me to an agent instead.',
    'ದಯವಿಟ್ಟು ಕರೆ ಮಾಡಿ',
    'ನನ್ನನ್ನು ಸಂಪರ್ಕಿಸಿ',
    'నాకు కాల్ చేయండి',
    'నన్ను సంప్రదించండి',
    'என்னை அழைக்கவும்',
    'எனக்கு கால் செய்யுங்கள்',
    'मुझे कॉल कीजिए',
    'हमसे संपर्क करें',
    'call madi',
    'please call maadi',
    'call cheyandi',
    'call pannunga',
    'mujhe call karo',
  ])('recognizes an explicit request: %s', (text) => {
    expect(detectCallbackRequest(text)).toBe(true);
  });
  it.each([
    'Please do not call me',
    'You should not call me',
    "I don't need a callback",
    'No callback required',
    'Cancel my callback',
    'A callback is not required',
    'Can I call your team?',
    'Can we contact you?',
    'What is your phone number?',
    'What are your callback hours?',
    'Can I get callback rates?',
    'Can I get a callback number?',
    'Do you offer callbacks?',
    'What is the call price?',
    'I need call records',
    'Tell me about your human agents',
    'The agent was helpful',
    'ನನಗೆ ಕರೆ ಮಾಡಬೇಡಿ',
    'ನಾನು ನಿಮಗೆ ಕರೆ ಮಾಡಬಹುದಾ?',
    'కాల్ చేయవద్దు',
    'నేను మీకు కాల్ చేయవచ్చా?',
    'என்னை அழைக்க வேண்டாம்',
    'நான் உங்களை அழைக்க முடியுமா?',
    'मुझे कॉल मत करो',
    'मैं आपको कॉल कर सकता हूँ?',
    'call mat karo',
    'call beda',
    'call vaddu',
    'call vendam',
  ])(
    'does not infer a callback from a refusal or an information question: %s',
    (text) => {
      expect(detectCallbackRequest(text)).toBe(false);
    },
  );
});

describe('unsupported model handoff claims', () => {
  it.each([
    'Our team will reach you soon.',
    'Our support team will contact you shortly.',
    'We’ll call you.',
    "We'll get back to you.",
    'The team will follow up with you.',
    'Someone from our team will be in touch with you.',
    'Someone will contact you.',
    'A member of our team will call you.',
    'Our team is going to contact you.',
    'Our team will arrange a callback.',
    'You will receive a call from us.',
    "You'll be contacted shortly.",
    'Expect a callback from our team.',
    'We have forwarded your request to our team.',
    'We will inform our team about your request.',
    'ನಮ್ಮ ತಂಡ ಶೀಘ್ರದಲ್ಲೇ ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತದೆ.',
    'మా బృందం త్వరలో మిమ్మల్ని సంప్రదిస్తుంది.',
    'எங்கள் குழு விரைவில் உங்களைத் தொடர்பு கொள்ளும்.',
    'हमारी टीम जल्द ही आपसे संपर्क करेगी।',
  ])('requires durable handoff handling for: %s', (reply) => {
    expect(detectHandoffPromise(reply)).toBe(true);
  });
  it.each([
    'Please contact our team directly.',
    'Our team can help with your request.',
    'We will not call you.',
    "We won't contact you without permission.",
    'We cannot promise our team will contact you.',
    'Call our team during working hours.',
    'Your cake is available.',
    'हमारी टीम आपसे संपर्क नहीं करेगी।',
    'எங்கள் குழு உங்களைத் தொடர்பு கொள்ளாது.',
  ])(
    'does not turn an instruction or negated claim into a promise: %s',
    (reply) => {
      expect(detectHandoffPromise(reply)).toBe(false);
    },
  );
  it('overrides a provider-marked grounded promise even for a greeting', () => {
    const profile = bakeryProfile();
    for (const question of ['Hi', 'When will someone contact me?'])
      expect(
        validateGroundedReply(
          {
            reply: 'Our team will reach you soon.',
            needsHuman: false,
            evidenceIds: ['business-information'],
          },
          profile,
          question,
        ),
      ).toMatchObject({ needsHuman: true, grounded: false });
  });
});

describe('truthful handoff acknowledgements', () => {
  it.each(['en', 'kn', 'te', 'ta', 'hi'])(
    '%s distinguishes saved requests from failed persistence',
    (language) => {
      const saved = handoffAcknowledgement(language, true);
      const failed = handoffAcknowledgement(language, false);
      expect(saved.length).toBeGreaterThan(20);
      expect(failed.length).toBeGreaterThan(20);
      expect(saved).not.toBe(failed);
      expect(detectHandoffPromise(saved)).toBe(false);
      expect(detectHandoffPromise(failed)).toBe(false);
    },
  );
  it('claims only a saved request and manual review, never a guaranteed callback or notification', () => {
    expect(handoffAcknowledgement('en', true)).toBe(
      'I’ve added your request to the admin follow-up inbox for manual review.',
    );
    expect(handoffAcknowledgement('en', true)).not.toMatch(
      /question|notified|informed|will|soon|callback|contact you/i,
    );
    expect(handoffAcknowledgement('en', false)).toBe(
      'I couldn’t confirm that your request was saved for manual review. Please contact our team directly for help.',
    );
    expect(handoffAcknowledgement('en', false)).not.toContain(
      'I couldn’t save',
    );
    expect(handoffAcknowledgement('unsupported', true)).toBe(
      handoffAcknowledgement('en', true),
    );
  });
});
