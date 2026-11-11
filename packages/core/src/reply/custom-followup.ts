import type { BusinessProfile } from '@assistant/contracts';
import { handoffAcknowledgement } from './handoff.js';

// A custom acknowledgement is operator text, not a model prompt or proof of an
// action. Future personal contact requires the separate business commitment;
// completed notifications, scheduling and transactions need real evidence.
const unsupportedActions = [
  /\b(?:notified|informed|alerted|forwarded|escalated|assigned|dispatched)\b/iu,
  /\b(?:notify|inform|alert|forward|escalate)\b.{0,50}\b(?:team|staff|agent|manager)\b/iu,
  /\b(?:arranged|scheduled|booked)\b/iu,
  /\b(?:have|has|had|was|were|already|just|previously|successfully)\s+(?:(?:been|already|just|successfully)\s+){0,3}(?:called|contacted|emailed|messaged|reached|spoken|talked)\b/iu,
  /\b(?:we|i|(?:our|the)\s+(?:team|staff|agent|manager))\s+(?:called|contacted|emailed|messaged|reached)\b/iu,
  /\b(?:our|the)\s+(?:team|staff|agent|representative|manager)\b.{0,25}\b(?:already|has|have|was|were|received)\b/iu,
  /\b(?:is|are)\s+(?:being\s+)?(?:handled|processed|reviewed|resolved)\b/iu,
  /\b(?:payment|refund|order|application)\b.{0,30}\b(?:processed|approved|confirmed|completed|paid|refunded|sent|shipped|delivered)\b/iu,
  /\b(?:processed|approved|confirmed|completed)\b.{0,25}\b(?:payment|refund|order|application)\b/iu,
  /(?:ತಿಳಿಸಲಾಗಿದೆ|ತಿಳಿಸಿದ್ದೇವೆ|ಸೂಚಿಸಲಾಗಿದೆ|ಕಳುಹಿಸಲಾಗಿದೆ|ಕಳುಹಿಸಿದ್ದೇವೆ|ಸಂಪರ್ಕಿಸಲಾಗಿದೆ|ಸಂಪರ್ಕಿಸಿದ್ದೇವೆ)/u,
  /(?:ಕರೆ|ಫೋನ್).{0,15}(?:ನಿಗದಿ|ವ್ಯವಸ್ಥೆ ಮಾಡಲಾಗಿದೆ|ಮಾಡಲಾಗಿದೆ|ಮಾಡಿದ್ದೇವೆ)/u,
  /(?:ಪಾವತಿ|ಮರುಪಾವತಿ).{0,20}(?:ಪೂರ್ಣಗೊಂಡಿದೆ|ಮಾಡಲಾಗಿದೆ|ಅನುಮೋದಿಸಲಾಗಿದೆ)/u,
  /(?:తెలియజేయబడింది|తెలియజేశాము|తెలియజేశాం|పంపబడింది|సంప్రదించింది|సంప్రదించాము|సంప్రదించాం)/u,
  /(?:బృందానికి|టీమ్‌కు|సిబ్బందికి).{0,25}(?:తెలిపా|తెలియజేశా|పంపా)/u,
  /(?:కాల్|ఫోన్).{0,15}(?:షెడ్యూల్|నిర్ణయించ|ఏర్పాటు చేశా|ఏర్పాటు చేయబడింది|చేశాము|చేశాం)/u,
  /(?:చెల్లింపు|రీఫండ్).{0,20}(?:పూర్తయింది|ప్రాసెస్ చేయబడింది|ఆమోదించబడింది)/u,
  /(?:தெரிவிக்கப்பட்ட|அறிவிக்கப்பட்ட|அனுப்பப்பட்ட|தெரிவித்துவிட்டோம்|அறிவித்துவிட்டோம்|தொடர்பு கொண்டோம்|தொடர்பு கொண்டுவிட்டோம்|அழைத்தோம்|அழைத்துவிட்டோம்)/u,
  /(?:அழைப்பு|கால்).{0,20}(?:திட்டமிடப்பட்ட|ஏற்பாடு செய்யப்பட்ட|நியமிக்கப்பட்ட)/u,
  /(?:பணம்|பணத்திருப்பம்).{0,20}(?:செலுத்தப்பட்டது|முடிந்தது|அங்கீகரிக்கப்பட்டது)/u,
  /(?:टीम|दल|कर्मचारी).{0,30}(?:सूचित|बताया|जानकारी दी|भेज दिया|भेजा|अवगत)/u,
  /(?:कॉल|फोन|फ़ोन|कॉलबैक).{0,20}(?:तय|निर्धारित|बुक|शेड्यूल|व्यवस्था|कर लिया|किया है)/u,
  /(?:संपर्क किया|बात की|भुगतान पूरा|रिफंड किया|भुगतान संसाधित)/u,
];

const explicitDeadlines =
  /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december|(?:in|on|this|next)\s+may|(?:this|next)\s+(?:morning|afternoon|evening|week|month|year))\b|(?:ಇಂದು|ನಾಳೆ|ಗಂಟೆ|ನಿಮಿಷ|ఈరోజు|రేపు|గంట|నిమిష|இன்று|நாளை|மணிநேர|நிமிட|आज|कल|घंट|मिनट)/iu;

/** Conservative plain-text validation, not proof that an arbitrary claim is true. */
export function isSafeFollowupReply(text: string): boolean {
  if (text.length > 1000 || text.trim().length === 0) return false;
  const normalized = text.normalize('NFKC').replace(/[’‘]/gu, "'");
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (
      code <= 31 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return false;
  }
  if (
    /[\p{N}\p{Sc}]/u.test(normalized) ||
    ['<', '>', '{', '}', '[', ']', '`'].some((token) =>
      normalized.includes(token),
    ) ||
    /\b(?:https?:|www\.|mailto:|tel:)|\b(?:[a-z][a-z-]*\.)+[a-z]{2,}\b/iu.test(
      normalized,
    ) ||
    /\b(?:api[\s_-]?key|password|bearer|authorization|access[\s_-]?token|ignore\s+(?:previous|prior|all)\s+instructions)\b|(?:^|\s)(?:system|assistant|developer)\s*:/iu.test(
      normalized,
    ) ||
    /\b(?:sk-[a-z_-]{8,}|aiza[a-z_-]{24,})\b/iu.test(normalized) ||
    explicitDeadlines.test(normalized)
  )
    return false;
  return !unsupportedActions.some((rule) => rule.test(normalized));
}

/** Called only after a durable inbox save; never use this for uncertain saves. */
export function savedFollowupReply(
  profile: BusinessProfile,
  language: string,
): string {
  return profile.followupCommitmentConfirmed &&
    isSafeFollowupReply(profile.followupReply)
    ? profile.followupReply.trim()
    : handoffAcknowledgement(language, true);
}
