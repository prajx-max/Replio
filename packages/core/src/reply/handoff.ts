// These conservative rules trigger manual review, not a promise of contact.
// Customer text is evidence to classify; it never supplies executable policy.
function clauses(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/gu, "'")
    .split(/[.!?;,\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

const declinedRequest = [
  /\b(?:do not|don't|dont|never|stop|no need to)\s+(?:please\s+)?(?:call|phone|ring|contact)\b/u,
  /\b(?:not|no)\s+(?:call|phone|ring|contact)\s+(?:me|us)\b/u,
  /\b(?:do not|don't|dont)\s+(?:want|need|require)\s+(?:a\s+)?(?:call[\s-]?back|call|human|agent)\b/u,
  /\b(?:no|cancel|cancelled)\s+(?:a\s+|the\s+|my\s+)?(?:call[\s-]?back|call request)\b/u,
  /\b(?:call[\s-]?back|call)\s+(?:is\s+)?(?:not needed|not required|unnecessary)\b/u,
  /\b(?:call|phone)\s+(?:mat|nahi|nahin|beda|vaddu|vaddhu|vendam)\b/u,
  /(?:ಕರೆ|ಫೋನ್|ಸಂಪರ್ಕ).{0,12}(?:ಬೇಡ|ಮಾಡಬೇಡಿ|ಮಾಡಬೇಡ)/u,
  /(?:కాల్|ఫోన్|సంప్రదించ).{0,12}(?:వద్దు|చేయకండి|చేయవద్దు)/u,
  /(?:அழைக்க|கால்|போன்|தொடர்பு).{0,12}(?:வேண்டாம்|செய்யாதீர்கள்)/u,
  /(?:कॉल|फोन|फ़ोन|संपर्क).{0,12}(?:मत|नहीं|नही)/u,
  /(?:मत|नहीं|नही).{0,8}(?:कॉल|फोन|फ़ोन|संपर्क)/u,
];
const callbackRequest = [
  /\b(?:call|phone|ring)\s+(?:me|us)\b/u,
  /\b(?:can|could|would|will)\s+(?:you|someone|your\s+(?:team|agent|staff|manager))\s+(?:please\s+)?(?:call|phone|ring|contact)\s+(?:me|us)\b/u,
  /\b(?:please|kindly)\s+(?:contact|call|phone|ring)\s+(?:me|us)\b/u,
  /\b(?:i|we)\s+(?:need|want|request|would like)\s+(?:a\s+)?(?:call[\s-]?back|call)\b(?!\s+(?:rates?|cost|price|charges|records?|history|duration|number|hours)\b)/u,
  /\b(?:can|could|may)\s+(?:i|we)\s+(?:get|have|request)\s+(?:a\s+)?(?:call[\s-]?back|call)\b(?!\s+(?:rates?|cost|price|charges|records?|history|duration|number|hours)\b)/u,
  /\b(?:arrange|schedule|request)\s+(?:a\s+|my\s+)?call[\s-]?back\b/u,
  /\bcall[\s-]?back\s+(?:please|pls|needed|requested)\b/u,
  /^(?:please\s+)?call[\s-]?back(?:\s+(?:please|pls))?$/u,
  /\b(?:connect|transfer)\s+(?:me|us)\s+(?:to|with)\s+(?:(?:a|an|your|the)\s+)?(?:human|agent|representative|manager|real person)\b/u,
  /\b(?:i|we)\s+(?:want|need|would like)\s+to\s+(?:speak|talk)\s+(?:to|with)\s+(?:(?:a|an|your|the)\s+)?(?:human|agent|representative|manager|team|real person)\b/u,
  /\b(?:can|could|may)\s+(?:i|we)\s+(?:speak|talk)\s+(?:to|with)\s+(?:(?:a|an|your|the)\s+)?(?:human|agent|representative|manager|team|real person)\b/u,
  /\b(?:human|live|support)\s+(?:agent|representative)\s+(?:please|pls)\b/u,
  /\b(?:please\s+(?:let\s+(?:me|us)\s+)?|let\s+(?:me|us)\s+)(?:speak|talk)\s+(?:to|with)\s+(?:(?:a|an|your|the)\s+)?(?:human|agent|representative|manager|team|real person)\b/u,
  /\b(?:i|we)\s+(?:need|want|would like)\s+(?:human\s+(?:help|assistance|support)|(?:a|an)\s+(?:human|agent|representative))\b/u,
  /\b(?:call|phone)\s+(?:madi|maadi|madthira|madteera|cheyandi|cheyyandi|cheyara|pannunga|pannuveengala|karo|kijiye|kariye|karen|karoge)\b/u,
  /(?:ಕರೆ|ಫೋನ್)\s*(?:ಮಾಡಿ|ಮಾಡುತ್ತೀರಾ|ಮಾಡಬಹುದಾ|ಮಾಡಬಲ್ಲಿರಾ)/u,
  /(?:ನನ್ನನ್ನು|ನಮ್ಮನ್ನು)\s*ಸಂಪರ್ಕಿಸಿ/u,
  /(?:కాల్|ఫోన్)\s*(?:చేయండి|చేస్తారా|చేయగలరా)/u,
  /(?:నన్ను|మమ్మల్ని)\s*సంప్రదించండి/u,
  /(?:என்னை|எனக்கு|எங்களை|எங்களுக்கு).{0,16}(?:அழைக்கவும்|அழையுங்கள்|அழைக்க முடியுமா|கால் செய்யுங்கள்|தொடர்பு கொள்ளுங்கள்)/u,
  /(?:मुझे|हमें|मुझसे|हमसे).{0,16}(?:कॉल|फोन|फ़ोन|संपर्क).{0,12}(?:करें|करो|कीजिए|करिए|कर सकते|कर देंगे)/u,
];
const outgoingQuestion = [
  /\b(?:can|could|may)\s+(?:i|we)\s+(?:call|phone|contact)\s+(?:you|your team)\b/u,
  /(?:ನಾನು|ನಾವು).{0,12}(?:ನಿಮಗೆ|ನಿಮ್ಮ).{0,12}(?:ಕರೆ|ಫೋನ್)/u,
  /(?:నేను|మేము).{0,12}(?:మీకు|మిమ్మల్ని).{0,12}(?:కాల్|ఫోన్)/u,
  /(?:நான்|நாங்கள்).{0,12}(?:உங்களை|உங்களுக்கு).{0,12}(?:அழைக்க|கால்)/u,
  /(?:मैं|हम).{0,12}(?:आपको|आपसे).{0,12}(?:कॉल|फोन|फ़ोन)/u,
];

export function detectCallbackRequest(text: string): boolean {
  return clauses(text).some(
    (part) =>
      !declinedRequest.some((rule) => rule.test(part)) &&
      !outgoingQuestion.some((rule) => rule.test(part)) &&
      callbackRequest.some((rule) => rule.test(part)),
  );
}

const declinedPromise = [
  /\b(?:cannot|can't|do not|don't)\s+(?:promise|guarantee)\b/u,
  /\b(?:will|shall)\s+(?:not|never)\b/u,
  /\b(?:won't|cannot|can't)\s+(?:call|contact|phone|reach|email|message)\b/u,
  /(?:ಮಾಡುವುದಿಲ್ಲ|ಸಂಪರ್ಕಿಸುವುದಿಲ್ಲ)/u,
  /(?:సంప్రదించము|చేయము|చేయలేము)/u,
  /(?:அழைக்க மாட்டோம்|தொடர்பு கொள்ள முடியாது)/u,
  /(?:அழைக்காது|அழைக்க மாட்டார்கள்|தொடர்பு கொள்ளாது)/u,
  /(?:संपर्क|कॉल|फोन|फ़ोन).{0,8}(?:नहीं|नही)/u,
];
const handoffPromise = [
  /\b(?:we(?:'ll| will| shall)|(?:our|the)\s+(?:support\s+)?(?:team|staff|agent|representative|manager)(?:\s+member)?\s+(?:will|shall)|someone\s+from\s+our\s+team\s+(?:will|shall))\s+(?:(?:soon|shortly|personally|be able to)\s+)?(?:call|phone|contact|email|message|reach(?:\s+out)?(?:\s+to)?|get\s+back\s+to|follow\s+up\s+with|be\s+in\s+touch\s+with)\s+(?:you|u|the customer)\b/u,
  /\b(?:we(?:'ll| will| shall)|(?:our|the)\s+team\s+(?:will|shall))\s+(?:arrange|schedule)\s+(?:a\s+|your\s+)?call[\s-]?back\b/u,
  /\b(?:someone|a\s+(?:(?:team|staff)\s+member|member\s+of\s+(?:our|the)\s+team))\s+(?:will|shall)\s+(?:call|phone|contact|email|message)\s+you\b/u,
  /\b(?:we(?:'re| are)|(?:our|the)\s+(?:support\s+)?team(?: is|'s))\s+going\s+to\s+(?:call|phone|contact|email|message|reach(?:\s+out)?(?:\s+to)?|get\s+back\s+to)\s+you\b/u,
  /\byou(?:\s+will|'ll)\s+(?:receive|get)\s+(?:a\s+)?(?:call|call[\s-]?back)\b/u,
  /\byou(?:\s+will|'ll)\s+be\s+(?:called|contacted|emailed|messaged)\b/u,
  /\b(?:expect|await)\s+(?:a\s+)?(?:call|call[\s-]?back)\s+from\s+(?:our|the)\s+team\b/u,
  /\b(?:i|we|our team)\s+(?:have|has)\s+(?:already\s+)?(?:forwarded|escalated|reported)\s+.{0,60}\b(?:team|staff|agent|manager)\b/u,
  /\b(?:we|i)(?:'ll|\s+will)\s+(?:notify|inform|forward|escalate)\s+.{0,60}\b(?:team|staff|agent|manager)\b/u,
  /(?:ನಮ್ಮ\s*ತಂಡ|ನಾವು).{0,35}(?:ನಿಮ್ಮನ್ನು\s*ಸಂಪರ್ಕಿ|ನಿಮಗೆ\s*(?:ಕರೆ|ಫೋನ್))/u,
  /(?:మా\s*బృందం|మేము).{0,35}(?:మిమ్మల్ని\s*సంప్రదిస్త|మీకు\s*(?:కాల్|ఫోన్))/u,
  /(?:எங்கள்\s*குழு|நாங்கள்).{0,35}(?:உங்களை.{0,12}தொடர்பு|உங்களை.{0,12}அழைப்போம்)/u,
  /(?:हमारी\s*टीम|हम).{0,35}(?:आपसे\s*संपर्क|आपको\s*(?:कॉल|फोन|फ़ोन))/u,
];

/** Detect unsupported contact/action claims even if the model marks its reply grounded. */
export function detectHandoffPromise(reply: string): boolean {
  return clauses(reply).some(
    (part) =>
      !declinedPromise.some((rule) => rule.test(part)) &&
      handoffPromise.some((rule) => rule.test(part)),
  );
}

const acknowledgements: Record<string, { saved: string; failed: string }> = {
  en: {
    saved:
      'I’ve added your request to the admin follow-up inbox for manual review.',
    failed:
      'I couldn’t confirm that your request was saved for manual review. Please contact our team directly for help.',
  },
  kn: {
    saved:
      'ನಿಮ್ಮ ವಿನಂತಿಯನ್ನು ಕೈಯಾರೆ ಪರಿಶೀಲಿಸಲು ನಿರ್ವಾಹಕರ ಫಾಲೋ-ಅಪ್ ಇನ್‌ಬಾಕ್ಸ್‌ಗೆ ಸೇರಿಸಿದ್ದೇನೆ.',
    failed:
      'ನಿಮ್ಮ ವಿನಂತಿಯನ್ನು ಕೈಯಾರೆ ಪರಿಶೀಲಿಸಲು ಉಳಿಸಲಾಗಿದೆ ಎಂದು ಖಚಿತಪಡಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ಸಹಾಯಕ್ಕಾಗಿ ದಯವಿಟ್ಟು ನಮ್ಮ ತಂಡವನ್ನು ನೇರವಾಗಿ ಸಂಪರ್ಕಿಸಿ.',
  },
  te: {
    saved:
      'మీ అభ్యర్థనను మానవ సమీక్ష కోసం నిర్వాహకుల ఫాలో-అప్ ఇన్‌బాక్స్‌లో చేర్చాను.',
    failed:
      'మీ అభ్యర్థన మానవ సమీక్ష కోసం సేవ్ అయిందని నిర్ధారించలేకపోయాను. సహాయం కోసం దయచేసి మా బృందాన్ని నేరుగా సంప్రదించండి.',
  },
  ta: {
    saved:
      'உங்கள் கோரிக்கையை கைமுறை பரிசீலனைக்காக நிர்வாகியின் பின்தொடர்பு இன்பாக்ஸில் சேர்த்துள்ளேன்.',
    failed:
      'உங்கள் கோரிக்கை கைமுறை பரிசீலனைக்காகச் சேமிக்கப்பட்டதை உறுதிப்படுத்த முடியவில்லை. உதவிக்கு எங்கள் குழுவை நேரடியாகத் தொடர்பு கொள்ளவும்.',
  },
  hi: {
    saved:
      'आपका अनुरोध मैन्युअल समीक्षा के लिए एडमिन के फ़ॉलो-अप इनबॉक्स में जोड़ दिया है।',
    failed:
      'यह पुष्टि नहीं कर पाया कि आपका अनुरोध मैन्युअल समीक्षा के लिए सहेजा गया है। सहायता के लिए कृपया हमारी टीम से सीधे संपर्क करें।',
  },
};

/** The caller must obtain a durable save result before passing saved=true. */
export function handoffAcknowledgement(
  language: string,
  saved: boolean,
): string {
  const messages = acknowledgements[language] ?? acknowledgements.en;
  return messages ? (saved ? messages.saved : messages.failed) : '';
}
